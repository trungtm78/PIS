import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DecisionDocumentsScreen from './DecisionDocumentsScreen';
import { ANNUAL_ID, PUBLISHED_ID, mount, plan, planClient, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-05', 'FR-CAP-05');
const READER = ['capital.read', 'plan_version.read'];

afterEach(cleanup);

function open(state: PlanWorld) {
  const h = planClient(state);
  mount(<DecisionDocumentsScreen route={ROUTE} />, h, { permissions: READER });
  return h;
}
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-document-id]'));

describe('DecisionDocumentsScreen (CAP-05): the decisions that give capital out', () => {
  it('lists the decision behind every appropriation and every published plan with its number, authority, date, value and what it backs (UI-CAP-05)', async () => {
    open(planWorld());
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.decisions.page.title']);
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['cap.decisions.column.symbol'],
      vi_['cap.decisions.column.authority'],
      vi_['cap.decisions.column.date'],
      vi_['cap.decisions.column.value'],
      vi_['cap.decisions.column.basis'],
    ]);
    const plansRow = rows().find((row) => row.getAttribute('data-basis') === 'PLAN') as HTMLElement;
    expect(plansRow.textContent).toContain('12/QD-UBND');
    expect(plansRow.textContent).toContain('2025-01-10');
    expect(plansRow.textContent).toContain(vi_['cap.decisions.authority.none']);
    expect(plansRow.querySelector('a')?.getAttribute('href')).toBe(`/cap/cap-10?plan=${PUBLISHED_ID}`);
    const appropriationRow = rows().find((row) => row.getAttribute('data-basis') === 'APPROPRIATION') as HTMLElement;
    expect(appropriationRow.querySelector('a')?.getAttribute('href')).toBe('/cap/cap-16');
    // A plan in work has no decision yet and is not listed.
    expect(rows().some((row) => row.querySelector(`a[href$="${ANNUAL_ID}"]`) !== null)).toBe(false);
  });

  it('keeps a replaced plan in the list with its note, because its decision still grounds the reports made under it', async () => {
    const state = planWorld();
    state.plans = [...state.plans, plan(ANNUAL_ID.replace(/1$/, '9'), { plan_code: 'CP-2024', status: 'SUPERSEDED', decision_document: { id: '00000000-0000-4000-8000-000000000044', symbol: '07/QD-UBND', issued_on: '2024-02-01' } })];
    open(state);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const replaced = rows().find((row) => row.textContent?.includes('07/QD-UBND')) as HTMLElement;
    expect(replaced.textContent).toContain(vi_['cap.approval.superseded.label']);
  });

  it('says so when a read is refused', async () => {
    const state = planWorld();
    state.failing.set('listAppropriations', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    open(state);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bạn chưa có quyền truy cập'));
  });
});
