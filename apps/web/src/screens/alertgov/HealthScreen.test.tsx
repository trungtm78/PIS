import { ApiError } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../i18n';
import HealthScreen from './HealthScreen';
import { CODES, HEALTH_READER, READER, UNIT, client, failing, healthDto, mount, route, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('HOME-13', 'FR-HOME-13', 'HOME');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, permissions: readonly string[] | undefined = HEALTH_READER) {
  const h = client(state);
  const view = mount(<HealthScreen route={ROUTE} />, h, { permissions, path: '/home/home-13' });
  return { h, ...view };
}

describe('HealthScreen (HOME-13): the health of the alert system', () => {
  it('shows a skeleton while it loads, never a figure that is zero', async () => {
    const { h } = open(world());
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeInTheDocument();
    expect(screen.queryByTestId('figure-value')).toBeNull();
    await screen.findByTestId('kpi-MTTA');
    expect(h.read).toHaveBeenCalledWith('getAlertHealth', { query: { days: '28' } });
  });

  it('draws the fourteen indicators, each with its figure, target, status and sample', async () => {
    open(world());
    await screen.findByTestId('kpi-MTTA');
    for (const code of CODES) expect(screen.getByTestId(`kpi-${code}`)).toBeInTheDocument();
    const mtta = screen.getByTestId('kpi-MTTA');
    expect(within(mtta).getByTestId('figure-value').textContent).toBe('2,5');
    expect(mtta.textContent).toContain(text('alertgov.kpi.status.ok'));
    expect(mtta.textContent).toContain(text('alertgov.health.target.max', { value: `4 ${text('alertgov.unit.hours.text')}` }));
    expect(mtta.textContent).toContain(text('alertgov.health.sample.text', { count: 3 }));
    expect(within(mtta).getByTestId('low-sample')).toBeInTheDocument();
    const escalated = screen.getByTestId('kpi-ESCALATED');
    expect(escalated.getAttribute('data-status')).toBe('BREACH');
    expect(escalated.textContent).toContain(text('alertgov.kpi.status.breach'));
    expect(within(mtta).getByTestId('part-ACTION').textContent).toContain(text('alertgov.kpi.status.breach'));
    expect(within(screen.getByTestId('kpi-STALE')).getByTestId('part-OVER_7_DAYS').textContent).toContain(text('alertgov.kpi.part.overNDays', { days: '7' }));
  });

  it('says why a figure is missing and never shows it as zero', async () => {
    open(world());
    await screen.findByTestId('kpi-MTTR');
    const mttr = screen.getByTestId('kpi-MTTR');
    expect(within(mttr).getByTestId('figure-none').textContent).toBe('—');
    expect(within(mttr).queryByTestId('figure-value')).toBeNull();
    expect(within(mttr).getByTestId('kpi-note').textContent).toBe(text('alertgov.kpi.note.noRecords'));
    const delivery = screen.getByTestId('kpi-URGENT_DELIVERY');
    expect(delivery.getAttribute('data-status')).toBe('NO_SOURCE');
    expect(within(delivery).getByTestId('kpi-note').textContent).toBe(text('alertgov.kpi.note.noDeliveryReceipts'));
    // A zero that is a real zero (no orphan) is shown as zero.
    expect(within(screen.getByTestId('kpi-ORPHAN')).getByTestId('figure-value').textContent).toBe('0');
  });

  it('puts an "i" on every figure with the formula, the source, the moment, the version and the label of a default nobody confirmed', async () => {
    open(world());
    await screen.findByTestId('kpi-MTTA');
    const buttons = screen.getAllByRole('button', { name: /Công thức và nguồn của/ });
    // Fourteen indicators and the rule of the page are the figures with an "i"; the ones of the indicators are fourteen.
    expect(buttons.length).toBeGreaterThanOrEqual(14);
    const mtta = screen.getByTestId('kpi-MTTA');
    await userEvent.click(within(mtta).getByRole('button', { name: text('alertgov.info.open.label', { name: text('alertgov.kpi.name.mtta') }) }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Formula of MTTA.');
    expect(panel.textContent).toContain('Source of MTTA.');
    expect(panel.textContent).toContain(text('alertgov.info.version.text', { code: 'DEFAULT', version: 'builtin' }));
    expect(panel.textContent).toContain(text('alertgov.info.unverified.text'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says the rule is a default that nobody confirmed, and drops the label once the organisation approved its own', async () => {
    open(world());
    const note = await screen.findByTestId('rule-note');
    expect(note.textContent).toContain(text('alertgov.rule.unverified.label'));
    cleanup();
    open(world({ health: healthDto({ rule: { code: 'DEFAULT', version: '3', unverified: false, formula: 'f', source: 's', as_of: '2027-01-01', params: {} } }) }));
    const approved = await screen.findByTestId('rule-note');
    expect(approved.textContent).toContain(text('alertgov.rule.confirmed.label'));
    expect(approved.textContent).not.toContain(text('alertgov.rule.unverified.label'));
  });

  it('says "figures are old" when the job that records is older than two passes, with when it last wrote', async () => {
    open(world({ health: healthDto({ stale: true, last_pass_at: '2027-10-15T01:00:00.000Z' }) }));
    const banner = await screen.findByTestId('stale-banner');
    expect(banner.textContent).toContain(text('alertgov.health.stale.banner'));
    expect(banner.textContent).toContain('08:00');
    cleanup();
    open(world({ health: healthDto({ stale: true, last_pass_at: null }) }));
    expect((await screen.findByTestId('stale-banner')).textContent).toContain(text('alertgov.health.stale.never'));
  });

  it('does not show the banner when the figures are fresh', async () => {
    open(world());
    await screen.findByTestId('kpi-MTTA');
    expect(screen.queryByTestId('stale-banner')).toBeNull();
  });

  it('lists the ten largest types with the put-off rate (a small sample says so), the stale items by unit and the positions', async () => {
    open(world());
    const types = await screen.findByRole('table', { name: text('alertgov.health.types.caption') });
    expect(within(types).getByText('CLOCK')).toBeInTheDocument();
    expect(within(types).getByText('50%')).toBeInTheDocument();
    expect(within(types).getByText(text('alertgov.health.types.lowSample'))).toBeInTheDocument();
    const stale = screen.getByRole('table', { name: text('alertgov.health.stale.caption') });
    expect(within(stale).getByText('North unit')).toBeInTheDocument();
    const positions = screen.getByRole('table', { name: text('alertgov.health.positions.caption') });
    expect(within(positions).getByText(text('alertgov.position.state.singlePoint'))).toBeInTheDocument();
    expect(within(positions).getByText(text('alertgov.position.state.peerBacked'))).toBeInTheDocument();
  });

  it('shows empty tables as empty, not as a missing page', async () => {
    open(world({ health: healthDto({ top_types: [], stale_by_unit: [], positions: [], items: { in_window: 0, open: 0 } }) }));
    await screen.findByTestId('kpi-MTTA');
    expect(screen.getByTestId('items-summary').textContent).toBe(text('alertgov.health.items.summary', { window: 0, open: 0 }));
    expect(screen.getAllByText(text('states.empty.title')).length).toBeGreaterThanOrEqual(3);
  });

  it('asks again for the window that is chosen, and for the unit', async () => {
    const { h } = open(world());
    await screen.findByTestId('kpi-MTTA');
    await userEvent.selectOptions(screen.getByTestId('window'), '7');
    await screen.findByTestId('kpi-MTTA');
    expect(h.read).toHaveBeenCalledWith('getAlertHealth', { query: { days: '7' } });
    await userEvent.selectOptions(screen.getByTestId('unit'), UNIT);
    await screen.findByTestId('kpi-MTTA');
    expect(h.read).toHaveBeenCalledWith('getAlertHealth', { query: { days: '7', unit_id: UNIT } });
    expect(screen.getByTestId('unit')).toHaveValue(UNIT);
  });

  it('shows an error with a retry, and the page after the retry', async () => {
    const state = world({ failing: failing('getAlertHealth', new Error('boom')) });
    const { h } = open(state);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    state.failing.clear();
    await userEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await screen.findByTestId('kpi-MTTA');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getAlertHealth').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the last page and says so when a refresh fails', async () => {
    const state = world();
    const { queries } = open(state);
    await screen.findByTestId('kpi-MTTA');
    state.failing = failing('getAlertHealth', new Error('boom'));
    await queries.refetchQueries();
    expect(await screen.findByTestId('refresh-failed')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-MTTA')).toBeInTheDocument();
  });

  it('is denied without the right to read the health, and when the server refuses', async () => {
    const { h } = open(world(), READER);
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    const refused = world({ failing: failing('getAlertHealth', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) });
    open(refused);
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
  });
});
