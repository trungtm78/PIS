import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { line, mount, routeOf } from '../test-support';
import SettlementScreen from './SettlementScreen';
import { FAILURES, OTHER, PROJECT, asked, fill, open, settlement, word } from './test-support';
import type { Served } from './test-support';

const ROUTE = routeOf('PRJ-12', 'FR-PRJ-12');
const READER = ['project.read', 'settlement_revision.read'];

afterEach(cleanup);

const show = (served: Served, status = 'COMPLETED', permissions: readonly string[] = READER, project: string | null = PROJECT) => {
  const h = open(served, [line(1, { status }), line(2)]);
  mount(<SettlementScreen route={ROUTE} />, h, { permissions, path: `/prj/prj-12${project === null ? '' : `?id=${project}`}` });
  return h;
};

describe('SettlementScreen (PRJ-12): the settlement of a project', () => {
  it('UI-PRJ-12: shows the stage of the project, the figures of the settlement in force and every revision, and says the project waits for the settlement to close', async () => {
    const h = show({
      settlements: [
        settlement(2, { status: 'VERIFYING', settled_amount_vnd: '480000000000', outstanding_vnd: '12000000', unrecovered_advance_vnd: '3000000' }),
        settlement(1, { status: 'SUPERSEDED', settled_amount_vnd: '470000000000' }),
        settlement(3, { settlement_scope: 'ANNUAL', fiscal_year: 2026, status: 'CLOSED', closed_at: '2026-10-20T03:00:00.000Z' }),
        settlement(4, { settlement_scope: 'CONTRACT', contract: { id: '00000000-0000-4000-8000-000900000001', code: 'HD-01' }, project: { id: OTHER, code: 'X', name: 'Y' } }),
      ],
    });
    const standing = await screen.findByTestId('standing');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('prj.settlement.page.title'));
    expect(screen.getByTestId('closure').getAttribute('data-closure')).toBe('waiting');
    expect(screen.getByTestId('closure').textContent).toContain(fill(word('prj.settlement.stage.text'), { stage: word('prj.stage.completed.label') }));
    expect(screen.getByTestId('closure').textContent).toContain(word('prj.settlement.closure.waiting.notice'));
    expect(within(standing).getByRole('heading', { level: 2 }).textContent).toBe(fill(word('prj.settlement.standing.title'), { revision: 2 }));
    expect(standing.textContent).toContain(word('pay.settlement.status.verifying'));
    expect(standing.textContent).toContain('480.000.000.000');
    expect(standing.textContent).toContain('12.000.000');
    expect(standing.textContent).toContain('3.000.000');
    expect(standing.textContent).toContain(word('prj.settlement.exception.none'));
    expect(within(standing).queryByTestId('findings')).toBeNull();
    const rows = within(screen.getByTestId('settlements')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain(word('pay.settlement.status.superseded'));
    expect(rows[2]?.textContent).toContain(fill(word('prj.settlement.year.text'), { year: 2026 }));
    expect(rows[2]?.querySelector('a')?.getAttribute('href')).toBe(`/pay/pay-15?settlement=${settlement(3).id}`);
    expect(asked(h, 'get_resources_settlement_revision')[0]?.[1]).toEqual({ query: { project_id: PROJECT, limit: '200' } });
  });

  it('shows the contract a settlement is for, the day it closed and the exception that was approved', async () => {
    show(
      {
        settlements: [
          settlement(1, { status: 'CLOSED', closed_at: '2026-10-20T03:00:00.000Z', outstanding_vnd: '5000', exception_approved_at: '2026-10-18T03:00:00.000Z' }),
          settlement(2, { settlement_scope: 'CONTRACT', contract: { id: '00000000-0000-4000-8000-000900000001', code: 'HD-01' }, status: 'DRAFT' }),
        ],
      },
      'SETTLED',
    );
    const standing = await screen.findByTestId('standing');
    expect(standing.textContent).toContain('2026-10-20');
    expect(standing.textContent).toContain(fill(word('prj.settlement.exception.approved'), { day: '2026-10-18' }));
    expect(screen.getByTestId('settlements').textContent).toContain('HD-01');
    expect(screen.getByTestId('closure').getAttribute('data-closure')).toBe('settled');
    expect(screen.getByTestId('closure').textContent).toContain(word('prj.settlement.closure.settled.notice'));
  });

  it('says the project has not moved yet when its settlement is closed and the stage is still completed', async () => {
    show({ settlements: [settlement(1, { status: 'CLOSED', closed_at: '2026-10-20T03:00:00.000Z' })] });
    await screen.findByTestId('standing');
    expect(screen.getByTestId('closure').getAttribute('data-closure')).toBe('closedAwaitingStage');
    expect(screen.getByTestId('closure').textContent).toContain(word('prj.settlement.closure.closedAwaitingStage.notice'));
  });

  it('says the settlement is not reached before the project is completed, and that there is no settlement of the project yet', async () => {
    show({ settlements: [] }, 'IMPLEMENTATION');
    expect((await screen.findByTestId('no-settlement')).textContent).toBe(word('prj.settlement.none.notice'));
    expect(screen.getByTestId('closure').getAttribute('data-closure')).toBe('notReached');
    expect(screen.getByTestId('closure').textContent).toContain(word('prj.settlement.closure.notReached.notice'));
    expect(screen.queryByTestId('settlements')).toBeNull();
  });

  it('shows the conclusions of the audit only when the read gave them', async () => {
    show({ settlements: [settlement(1, { audit_finding_refs: ['00000000-0000-4000-8000-000800000001', '00000000-0000-4000-8000-000800000002'] })] });
    expect((await screen.findByTestId('findings')).textContent).toBe(fill(word('prj.settlement.findings.count'), { count: 2 }));
  });

  it('shows the denied card and reads nothing when the caller may not read settlements', async () => {
    const h = show({ settlements: [settlement(1)] }, 'COMPLETED', ['project.read']);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('standing')).toBeNull();
    expect(screen.queryByLabelText(word('prj.revision.filter.project.label'))).toBeNull();
    expect(asked(h, 'get_resources_settlement_revision')).toHaveLength(0);
  });

  it('asks for a project when the address names none', async () => {
    const h = show({ settlements: [settlement(1)] }, 'COMPLETED', READER, null);
    expect((await screen.findByTestId('no-project')).textContent).toBe(word('prj.revision.noProject.notice'));
    expect(asked(h, 'get_resources_settlement_revision')).toHaveLength(0);
  });

  it('shows the skeleton while the settlements are read', async () => {
    show({ pending: ['get_resources_settlement_revision'] });
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  it('shows what it can for a project that is not in the list: the settlements without the stage', async () => {
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    show({ settlements: [settlement(1, { project: { id: unknown, code: 'DA-X', name: 'Dự án X' } })] }, 'COMPLETED', READER, unknown);
    await screen.findByTestId('standing');
    expect(screen.queryByTestId('closure')).toBeNull();
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the settlements fail, and reads again on retry`, async () => {
      const h = show({ failing: { get_resources_settlement_revision: failure } });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('standing')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(asked(h, 'get_resources_settlement_revision').length).toBeGreaterThan(1));
    });
  }
});
