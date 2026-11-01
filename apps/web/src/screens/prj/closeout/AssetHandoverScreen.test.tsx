import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, routeOf } from '../test-support';
import AssetHandoverScreen from './AssetHandoverScreen';
import { FAILURES, OTHER, PROJECT, asked, asset, fill, handover, open, problem, trace, word } from './test-support';
import type { Served } from './test-support';

const ROUTE = routeOf('PRJ-11', 'FR-PRJ-11');
const READER = ['project.read', 'handover.read'];

afterEach(cleanup);

const show = (served: Served, permissions: readonly string[] = READER, project: string | null = PROJECT) => {
  const h = open(served);
  mount(<AssetHandoverScreen route={ROUTE} />, h, { permissions, path: `/prj/prj-11${project === null ? '' : `?id=${project}`}` });
  return h;
};

const HANDOVERS = [
  handover(1, { status: 'ACCEPTED', handed_on: '2026-09-15', accepted_at: '2026-09-15T02:00:00.000Z', open_critical_punch_count: 0 }),
  handover(2, { handover_kind: 'ASSET_TRANSFER', recipient_unit: { id: '00000000-0000-4000-8000-000100000009', code: 'U9', name: 'Sở Tài chính' }, open_critical_punch_count: 2, punch_item_count: 5 }),
  handover(3, { status: 'REJECTED', rejection_reason: 'Chưa đạt' }),
  handover(4, { project_id: OTHER }),
];

describe('AssetHandoverScreen (PRJ-11): the handover of the assets of a project', () => {
  it('UI-PRJ-11: lists the handovers of the project with the asset kind, the receiving unit and the days, and counts the accepted and the ones on the way', async () => {
    const h = show({ handovers: HANDOVERS });
    const table = await screen.findByTestId('handovers');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('prj.handover.page.title'));
    for (const key of ['prj.handover.column.recipient', 'prj.handover.column.handed', 'prj.handover.column.planned', 'prj.handover.column.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: word(key) })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('BG-01');
    expect(rows[0]?.textContent).toContain('2026-09-15');
    expect(rows[0]?.textContent).toContain(word('ast.handover.status.accepted'));
    expect(rows[0]?.textContent).toContain(word('ast.handover.kind.completion'));
    expect(rows[1]?.textContent).toContain('Sở Tài chính');
    expect(rows[1]?.textContent).toContain(word('ast.handover.kind.assetTransfer'));
    expect(rows[1]?.querySelectorAll('td')[5]?.textContent).toBe('2');
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe(`/ast/ast-02?id=${HANDOVERS[1]?.id}`);
    expect(screen.getByTestId('counts').textContent).toBe(fill(word('prj.handover.summary.counts'), { project: 'DA-2026-001', accepted: 1, open: 1 }));
    expect(asked(h, 'get_resources_handover')).toHaveLength(1);
  });

  it('opens the assets of a handover with their value and state, and closes them again', async () => {
    const target = handover(2);
    show({ handovers: [target], trace: trace(target, { assets: [asset(1), asset(2, { name: null, value_vnd: '1000000', status: 'LOST' })], items: [{}, {}] }) });
    fireEvent.click(await screen.findByRole('button', { name: fill(word('prj.handover.assets.action'), { no: 'BG-02' }) }));
    const panel = await screen.findByTestId('assets-panel');
    const rows = within(await within(panel).findByTestId('assets'))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('TS-01');
    expect(rows[0]?.textContent).toContain('2.500.000.000');
    expect(rows[0]?.textContent).toContain(word('ast.asset.status.registered'));
    expect(rows[1]?.textContent).toContain('LOST');
    expect(rows[1]?.querySelectorAll('td')[0]?.textContent).toBe('—');
    expect(within(panel).getByTestId('trace-facts').textContent).toBe(fill(word('prj.handover.detail.facts'), { documents: 1, items: 0, critical: 0 }));
    expect(screen.getByRole('row', { selected: true }).getAttribute('data-handover')).toBe(target.id);
    fireEvent.click(within(panel).getByRole('button', { name: word('prj.handover.detail.close.action') }));
    await waitFor(() => expect(screen.queryByTestId('assets-panel')).toBeNull());
  });

  it('says when the handover carries no asset yet, and when it is not in the scope of the caller', async () => {
    const target = handover(1);
    show({ handovers: [target], trace: trace(target, { assets: [] }) });
    fireEvent.click(await screen.findByRole('button', { name: fill(word('prj.handover.assets.action'), { no: 'BG-01' }) }));
    expect((await screen.findByTestId('assets-none')).textContent).toBe(word('prj.handover.assets.none.notice'));
    cleanup();
    show({ handovers: [target], trace: problem(404, 'RESOURCE_NOT_FOUND') });
    fireEvent.click(await screen.findByRole('button', { name: fill(word('prj.handover.assets.action'), { no: 'BG-01' }) }));
    expect((await screen.findByTestId('trace-missing')).textContent).toBe(word('prj.handover.detail.missing.notice'));
  });

  it('shows the error card inside the panel when the trace fails, and keeps the list', async () => {
    show({ handovers: [handover(1)], trace: problem(500, 'INTERNAL_ERROR') });
    fireEvent.click(await screen.findByRole('button', { name: fill(word('prj.handover.assets.action'), { no: 'BG-01' }) }));
    const panel = await screen.findByTestId('assets-panel');
    expect(await within(panel).findByText(word('states.error.title'))).toBeTruthy();
    expect(screen.getByTestId('handovers')).toBeTruthy();
  });

  it('shows the denied card and reads nothing when the caller may not read handovers', async () => {
    const h = show({ handovers: HANDOVERS }, ['project.read']);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('handovers')).toBeNull();
    expect(asked(h, 'get_resources_handover')).toHaveLength(0);
  });

  it('asks for a project when the address names none', async () => {
    const h = show({ handovers: HANDOVERS }, READER, null);
    expect((await screen.findByTestId('no-project')).textContent).toBe(word('prj.revision.noProject.notice'));
    expect(asked(h, 'get_resources_handover')).toHaveLength(0);
  });

  it('shows the empty card for a project that has no handover, and the skeleton while it is read', async () => {
    show({ handovers: [handover(4, { project_id: OTHER })] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    show({ pending: ['get_resources_handover'] });
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the handovers fail, and reads again on retry`, async () => {
      const h = show({ failing: { get_resources_handover: failure } });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('handovers')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(asked(h, 'get_resources_handover').length).toBeGreaterThan(1));
    });
  }
});
