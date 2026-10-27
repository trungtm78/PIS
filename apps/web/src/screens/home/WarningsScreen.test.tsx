import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import WarningsScreen from './WarningsScreen';
import { observedAgainstExpected, toWarning, toWarningPage, trimmed } from './warning-model';

const ROUTE = routeOf('HOME-03', 'FR-HOME-03');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const W1 = '00000000-0000-4000-8000-000000000a01';
const W2 = '00000000-0000-4000-8000-000000000a02';
const P1 = '00000000-0000-4000-8000-000000000b01';
const LEADER = '00000000-0000-4000-8000-000000000001';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

export const warningBody = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  rule: { code: 'EW-01', name: 'Tỷ lệ giải ngân thấp hơn kỳ vọng', metric_code: 'YTD_RATE_GAP', comparator: 'GTE', threshold: { points: '10', critical_points: '20' } },
  severity: 'WARNING',
  status: 'OPEN',
  project: { id: P1, code: 'P-A-002', name: 'Cầu Bến Lức' },
  observed: { observed_pct: '22.0000', expected_pct: '45.0000', gap_points: '23.0000' },
  snapshot_id: S40,
  period_id: '00000000-0000-4000-8000-000000000c01',
  opened_at: '2027-10-02T03:00:00.000Z',
  closed_at: null,
  resolution_reason: null,
  version: 3,
  leader: { membership_id: LEADER, display_name: 'Nguyễn Văn A' },
  explanation: null,
  ...overrides,
});
const page = (items: unknown[], cursor: string | null = null) => ({ items, next_cursor: cursor, as_of: '2027-10-15T03:00:00Z' });

function client(answer: (query: Record<string, string | number>) => unknown): Harness {
  return harness((operation, input) => (operation === 'getHomeWarnings' ? answer(((input as { query?: Record<string, string | number> }).query ?? {}) as Record<string, string | number>) : new Error(`unexpected read ${operation}`)));
}
const calls = (h: Harness): Array<Record<string, string | number>> => h.read.mock.calls.filter((call) => call[0] === 'getHomeWarnings').map((call) => (call[1] as { query: Record<string, string | number> }).query);

afterEach(cleanup);

describe('HOME-03 early warnings (ST-HOME-003, HOME 3 F4)', () => {
  it('AC-ST-HOME-003-1: UAT-AC271 shows the rule, the severity as an icon and a word, the project, the 22% observed against the expected 45%, the leader and the open explanation', async () => {
    const open = warningBody(W1, { status: 'EXPLANATION_REQUESTED', explanation: { id: 'e1', status: 'REQUESTED', due_at: '2027-10-09T00:00:00.000Z', is_late: false } });
    mount(<WarningsScreen route={ROUTE} />, client(() => page([open])), { permissions: READER });
    const row = (await screen.findByText('EW-01')).closest('tr') as HTMLElement;
    expect(row.getAttribute('data-severity')).toBe('WARNING');
    // The severity is said in words and with an icon (hidden from assistive technology), never by colour alone.
    expect(within(row).getByText(vi_['home.warnings.severity.warning'])).toBeTruthy();
    expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚠');
    expect(within(row).getByText(/P-A-002/)).toBeTruthy();
    expect(screen.getByTestId(`observed-${W1}`).textContent).toBe(fill(vi_['home.warnings.observed.text'], { observed: '22', expected: '45' }));
    expect(screen.getByTestId(`leader-${W1}`).textContent).toBe('Nguyễn Văn A');
    expect(screen.getByTestId(`explanation-${W1}`).textContent).toBe(vi_['home.explanation.status.requested']);
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`/home/home-06?warning=${W1}`);
  });

  it('says a warning has no leader and no explanation in words, says an explanation is late, and does not invent a comparison for a rule that measured something else', async () => {
    const bare = warningBody(W1, { leader: null, explanation: null, observed: { metric: 'REPORT_OVERDUE' } });
    const late = warningBody(W2, { explanation: { id: 'e2', status: 'OVERDUE', due_at: '2027-10-01T00:00:00.000Z', is_late: true } });
    mount(<WarningsScreen route={ROUTE} />, client(() => page([bare, late])), { permissions: READER });
    await screen.findByTestId(`leader-${W1}`);
    expect(screen.getByTestId(`leader-${W1}`).textContent).toBe(vi_['home.warnings.leader.none']);
    expect(screen.getByTestId(`explanation-${W1}`).textContent).toBe(vi_['home.warnings.explanation.none']);
    expect(screen.getByTestId(`observed-${W1}`).textContent).toBe(vi_['home.warnings.observed.none']);
    expect(screen.getByTestId(`explanation-${W2}`).textContent).toBe(`${vi_['home.explanation.status.overdue']}, ${vi_['home.warnings.explanation.late']}`);
  });

  it('narrows by severity and by rule, and reads the next page', async () => {
    const user = userEvent.setup();
    const h = client((query) => (query.cursor === 'next' ? page([warningBody(W2)]) : page([warningBody(W1)], 'next')));
    mount(<WarningsScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId(`leader-${W1}`);
    await user.click(screen.getByRole('button', { name: vi_['home.warnings.more'] }));
    await waitFor(() => expect(screen.getByTestId(`leader-${W2}`)).toBeTruthy());
    await user.selectOptions(screen.getByLabelText(vi_['home.warnings.severity.label']), 'CRITICAL');
    await user.type(screen.getByLabelText(vi_['home.warnings.rule.label']), 'ew-02');
    await waitFor(() => expect(calls(h).at(-1)).toMatchObject({ severity: 'CRITICAL', rule_code: 'EW-02' }));
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', page([]), vi_['states.empty.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('UI-HOME-03 shows the %s state and keeps the filters', async (_name, reply, title) => {
      mount(<WarningsScreen route={ROUTE} />, client(() => reply), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByLabelText(vi_['home.warnings.severity.label'])).toBeTruthy();
    });

    it('UI-HOME-03 shows the loading state first, names the page, and retries after an error', async () => {
      mount(<WarningsScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.warnings.page.title'] })).toBeTruthy();
      cleanup();
      let failing = true;
      mount(<WarningsScreen route={ROUTE} />, client(() => (failing ? failure(500, 'INTERNAL_ERROR') : page([warningBody(W1)]))), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId(`leader-${W1}`)).toBeTruthy();
    });
  });
});

describe('the warning as the screens read it', () => {
  it('reads what makes a warning one, and leaves out an entry that lacks it', () => {
    expect(toWarning(warningBody(W1))?.ruleCode).toBe('EW-01');
    for (const bad of [null, {}, warningBody(W1, { severity: 'LOUD' }), warningBody(W1, { id: '' }), warningBody(W1, { snapshot_id: '' }), warningBody(W1, { rule: undefined })]) expect(toWarning(bad)).toBeUndefined();
    expect(toWarningPage({ items: [warningBody(W1), { nope: true }], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toWarningPage({ items: [warningBody(W1), { nope: true }] }).items).toHaveLength(1);
  });

  it('puts the observed value against the expected one without the zeros of the decimals, and says nothing when the rule measured something else', () => {
    expect(observedAgainstExpected({ observed_pct: '22.0000', expected_pct: '45.5000' })).toEqual({ observed: '22', expected: '45.5' });
    expect(observedAgainstExpected({ metric: 'REPORT_OVERDUE' })).toBeNull();
    expect([trimmed('100'), trimmed('0.0000'), trimmed('10.1000')]).toEqual(['100', '0', '10.1']);
  });
});
