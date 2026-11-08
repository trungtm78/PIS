import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import InvestorStandingScreen from './aud/InvestorStandingScreen';
import { AS_OF, fill, harness, mount, never, problem, routeOf, uuid, word, rx } from './test/docaud';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('AUD-17', 'AUD', 'FR-AUD-17');
const READ = ['aud.standing.read'];
const rule = { version: 0, unverified: true, weights: { overdue: 3, disputed: 2, open: 1, money: 1 }, money_step_vnd: '1000000000' };

const unit = (n: number, over: Record<string, unknown> = {}) => ({
  unit_id: uuid(n),
  unit_code: `CDT-${n}`,
  unit_name: `Investor ${n}`,
  follow_up_rank: n,
  score: 20 - n,
  total: 4,
  open: 2,
  overdue: 1,
  disputed: 1,
  closed: 1,
  closed_pct: 25,
  owed_vnd: '4000000000',
  disbursement_rank: null,
  disbursement_rate_pct: null,
  ...over,
});

function open(answer: (op: string, input: unknown) => unknown, path = '/') {
  const h = harness(answer);
  mount(<InvestorStandingScreen route={route} />, h, READ, path);
  return h;
}

const listWorld = (items: unknown[]) => (op: string): unknown => {
  if (op === 'listInvestorStandings') return { as_of: AS_OF, ranking_as_of: '2027-03-01', rule, items };
  return {};
};

describe('AUD-17, the follow-up order of the audit recommendations of the investors', () => {
  it('UI-AUD-17: orders the investors, shows the disbursement rank beside the score and never inside it, and says it is not a verdict', async () => {
    open(listWorld([unit(1, { disbursement_rank: 3, disbursement_rate_pct: '75.0000' }), unit(2), unit(3, { follow_up_rank: null, score: 0, total: 1, open: 0, overdue: 0, disputed: 0, owed_vnd: '0' })]));
    expect(await screen.findByTestId(`rank-${uuid(1)}`)).toBeTruthy();
    expect(screen.getByTestId(`rank-${uuid(1)}`).textContent).toBe('1');
    expect(screen.getByTestId(`rank-${uuid(3)}`).textContent).toBe(word('gov12da.aud17.rank.none'));
    expect(screen.getByTestId(`disbursement-${uuid(1)}`).textContent).toBe(fill('gov12da.aud17.disbursement.text', { rank: 3, rate: '75.0000' }));
    expect(screen.getByTestId(`disbursement-${uuid(2)}`).textContent).toBe(word('gov12da.aud17.disbursement.none'));
    expect(screen.getByTestId('standing-note').textContent).toBe(word('gov12da.aud17.note.text'));
    expect(screen.getByTestId('figure-ranked').textContent).toBe('2');
    expect(screen.getByTestId('figure-weights').textContent).toBe('3 / 2 / 1');
    expect(screen.getAllByText('4.000.000.000').length).toBeGreaterThan(0);
  });

  it('puts an "i" on the score and the money and says the weights are a default that is not confirmed', async () => {
    open(listWorld([unit(1)]));
    await screen.findByTestId(`rank-${uuid(1)}`);
    const buttons = screen.getAllByRole('button', { name: rx(word('gov12da.aud17.col.score')) });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    const panel = await screen.findByRole('dialog', { name: word('gov12da.aud17.col.score') });
    expect(within(panel).getByText(word('gov12da.info.label.unverified'))).toBeTruthy();
    expect(within(panel).getByText(word('gov12da.rule.standing.formula'))).toBeTruthy();
  });

  it('opens the profile of one investor with its recommendations and marks the late ones', async () => {
    const h = open(
      (op) => {
        if (op === 'listInvestorStandings') return { as_of: AS_OF, ranking_as_of: null, rule, items: [unit(1)] };
        if (op === 'getInvestorProfile')
          return {
            ...unit(1),
            as_of: AS_OF,
            ranking_as_of: null,
            ranked_units: 5,
            rule,
            recommendations: [
              { id: uuid(71), code: 'R-1', type: 'FINANCIAL_RECOVERY', status: 'IN_PROGRESS', due_on: '2027-01-15', amount_vnd: '5000000000', recovered_vnd: '1000000000', project_id: null, overdue: true },
              { id: uuid(72), code: 'R-2', type: 'PROCESS_CORRECTION', status: 'CLOSED', due_on: '2027-01-10', amount_vnd: null, recovered_vnd: '0', project_id: null, overdue: false },
            ],
          };
        return {};
      },
      `/?unit=${uuid(1)}`,
    );
    expect((await screen.findByTestId('profile-of')).textContent).toBe(fill('gov12da.aud17.profile.of', { rank: 1, total: 5 }));
    expect(h.read).toHaveBeenCalledWith('getInvestorProfile', expect.objectContaining({ path: { unit_id: uuid(1) } }));
    expect(screen.getByTestId(`due-${uuid(71)}`).textContent).toContain(word('gov12da.aud17.rcol.late'));
    expect(screen.getByTestId(`due-${uuid(72)}`).textContent).not.toContain(word('gov12da.aud17.rcol.late'));
    fireEvent.click(screen.getByTestId('back'));
    await waitFor(() => expect(screen.queryByTestId('profile-of')).toBeNull());
  });

  it('shows the loading, empty, error, denied and stale states', async () => {
    open(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open(listWorld([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    open(() => problem('RESOURCE_NOT_FOUND', 404), `/?unit=${uuid(9)}`);
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
  });
});
