import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { client as bidClient, mount as bidMount, treeDto, world } from '../../screens/bid/workflow/test-support';
import { describeViolations, seriousViolations } from '../../test/axe';
import FiguresDetailScreen from './FiguresDetailScreen';
import ProgressScreen, { outlineOf } from './ProgressScreen';
import { mountPwa, pwaClient, word } from './test-support';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanup);

describe('ProgressScreen (PWA-09): the procurement progress as a list', () => {
  it('lists the steps of each method in order with counts and lateness, the counts at the top and the ends apart', async () => {
    const h = bidClient(world());
    bidMount(<ProgressScreen />, h, { permissions: ['bid.read'], path: '/m/progress' });
    const kpis = await screen.findByTestId('kpis');
    expect(kpis.querySelector('[data-tile="total"]')?.textContent).toContain('4');
    expect(kpis.querySelector('[data-tile="late"]')?.getAttribute('data-tone')).toBe('danger');
    expect(kpis.querySelector('[data-tile="value"]')?.textContent).toContain('400');
    const method = document.querySelector('[data-method="OPEN_BIDDING"]') as HTMLElement;
    expect(method.textContent).toContain('Quy trình đấu thầu rộng rãi');
    const steps = Array.from(method.querySelectorAll('[data-step]')).map((item) => item.getAttribute('data-step'));
    expect(steps).toEqual(['S:OPEN_BIDDING:DOC_PREPARE', 'S:OPEN_BIDDING:EVALUATE']);
    const first = method.querySelector('[data-step="S:OPEN_BIDDING:DOC_PREPARE"]') as HTMLElement;
    expect(first.textContent).toContain('Lập hồ sơ mời thầu');
    expect(first.textContent).toContain('2 gói thầu');
    expect(first.textContent).toContain('1 trễ hạn');
    expect(first.textContent).toContain('trung vị 6 ngày');
    expect(screen.getByTestId('terminals').querySelector('[data-terminal="NOT_STARTED"]')?.textContent).toContain('1');
    expect(screen.getByTestId('pwa-full-tree').getAttribute('href')).toBe('/bid/bid-27');
    expect(h.read).toHaveBeenCalledWith('getPackageProcessTree', { query: {} });
  });

  it('opens the packages of a step on a tap and closes them on the next (AC-ST-PWA-002-2)', async () => {
    const h = bidClient(world());
    bidMount(<ProgressScreen />, h, { permissions: ['bid.read'], path: '/m/progress' });
    await screen.findByTestId('kpis');
    const step = document.querySelector('[data-step="S:OPEN_BIDDING:DOC_PREPARE"] [data-action="step"]') as HTMLElement;
    expect(step.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(step);
    const packages = await screen.findByTestId('packages');
    expect(step.getAttribute('aria-expanded')).toBe('true');
    expect(packages.querySelector('[data-package]')?.textContent).toContain('GT-1');
    expect(packages.textContent).toContain('Cầu qua sông');
    expect(packages.textContent).toContain('Nguyễn Văn An');
    expect(packages.textContent).toContain('Trễ 3 ngày');
    expect(h.read).toHaveBeenCalledWith('listPackageProcessTreeNodePackages', { query: expect.objectContaining({ node_id: 'S:OPEN_BIDDING:DOC_PREPARE' }) });
    fireEvent.click(step);
    expect(screen.queryByTestId('packages')).toBeNull();
  });

  it('says the scope is hidden without the right and asks the server nothing; an error retries in place', async () => {
    const hidden = bidClient(world());
    bidMount(<ProgressScreen />, hidden, { permissions: ['home.read'], path: '/m/progress' });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(hidden.read).not.toHaveBeenCalledWith('getPackageProcessTree', expect.anything());
    cleanup();
    const state = world();
    state.failing = new Map([['getPackageProcessTree', { error: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }), times: 1 }]]);
    bidMount(<ProgressScreen />, bidClient(state), { permissions: ['bid.read'], path: '/m/progress' });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('kpis');
  });

  it('has no serious accessibility violation and the steps are touch targets', async () => {
    bidMount(<ProgressScreen />, bidClient(world()), { permissions: ['bid.read'], path: '/m/progress' });
    await screen.findByTestId('kpis');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    for (const control of document.querySelectorAll('[data-action="step"], [data-testid="pwa-back"]')) expect(control.className).toContain('pwa-touch');
  });

  it('builds the outline from the tree: methods with steps by order, terminals summed over methods', () => {
    const outline = outlineOf(treeDto() as never);
    expect(outline.methods).toHaveLength(1);
    expect(outline.methods[0]?.steps.map((step) => step.step_code)).toEqual(['DOC_PREPARE', 'EVALUATE']);
    expect(outline.terminals).toEqual([{ terminal: 'NOT_STARTED', count: 1 }]);
  });
});

const tile = (code: string, overrides: Record<string, unknown> = {}) => ({ metric_code: code, value: '60.0000', numerator: '600000000000', denominator: '1000000000000', null_reason: null, unit: 'PERCENT', formula: 'x', definition_status: 'PROPOSED_PENDING_SIGNOFF', context_token: `token-${code}.sig`, ...overrides });
const center = {
  snapshot_id: '00000000-0000-4000-8000-0000000000f2',
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  freshness: 'FRESH',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: ['CXN-03'],
  scope: { unit_id: null, denominator_kind: null, projects: 3, scope_hash: 'h' },
  tiles: [tile('DISBURSEMENT_RATE_PM'), tile('DISBURSED_TREASURY', { unit: 'VND', value: '600000000000', numerator: null, denominator: null }), tile('PLAN_PM_ASSIGNED', { unit: 'VND', value: '1000000000000', numerator: null, denominator: null })],
  projects_without_data: 0,
  open_warnings: 0,
  overdue_explanations: 0,
  pending_reallocations: 0,
  quality_badge: 'NOT_ASSESSED',
};

describe('FiguresDetailScreen (PWA-08): the drill-down of the command center', () => {
  it('shows the amounts of the snapshot in one column and keeps going when another card cannot be read (AC-ST-PWA-002-1)', async () => {
    const h = pwaClient({ read: (operation) => (operation === 'getCommandCenter' ? center : new Error(`unexpected read ${operation}`)) });
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['home.read'], path: '/m/dashboard/detail' });
    const amounts = await screen.findByTestId('figures-amounts');
    expect(amounts.textContent).toContain('600');
    expect(screen.getByTestId('figures-context').textContent).toContain('12/10/2027');
    expect(screen.getByTestId('figures-ranking')).toBeInTheDocument();
    expect(h.read).toHaveBeenCalledWith('getCommandCenter', expect.anything());
  });

  it('says the scope is hidden without the right to read the command center', async () => {
    const h = pwaClient({});
    mountPwa(<FiguresDetailScreen />, h, { permissions: ['bid.read'], path: '/m/dashboard/detail' });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('the phone layout (360 px)', () => {
  // The stylesheet is written over several lines: the checks compare it with its whitespace collapsed.
  const css = readFileSync(join(__dirname, 'pwa.css'), 'utf8').replace(/\s+/g, ' ');

  it('keeps every screen to one column that never grows past the width, and wraps long words (AC-ST-PWA-002-3)', () => {
    expect(css).toMatch(/\.pwa-screen \{[^}]*max-width: 720px/);
    expect(css).toMatch(/\.pwa-screen \{[^}]*min-width: 0; overflow-wrap: anywhere/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^@]*\.pwa-screen table \{ display: block; overflow-x: auto; max-width: 100%; \}/);
    expect(css).toMatch(/\.pwa-tiles \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('gives every control a 44 px target and the step rows too', () => {
    expect(css).toMatch(/\.pwa-touch \{[^}]*min-height: 44px; min-width: 44px/);
    expect(css).toMatch(/\.pwa-step \{[^}]*width: 100%/);
    expect(css).toMatch(/\.pwa-sticky-actions \{[^}]*position: sticky; bottom: 0/);
  });

  it('moves the sheet to the bottom of a phone', () => {
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^}]*\.pwa-sheet-backdrop \{ place-items: end center/);
  });
});
