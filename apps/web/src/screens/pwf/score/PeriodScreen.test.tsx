import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import type { Answer } from '../test/fixtures';
import { mountAs } from '../templates/test/mount';
import PeriodScreen from './PeriodScreen';
import { HASH, PERIOD_ID, SCORE_ALL, UNIT, period, periodPage, preview, refusal, routeOf, serve, signals, text, uuid } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-14');
const ok = { operation_id: uuid(9), status: 'LOCKED', resource_version: 5 };

interface Setup {
  permissions?: readonly string[];
  current?: Answer;
  list?: Answer;
  commands?: Record<string, Answer>;
  signals?: Answer;
  path?: string;
  mode?: 'FULL' | 'READ_ONLY';
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      listStaffScorePeriods: setup.list ?? periodPage([period(), period({ id: uuid(5001), status: 'DRAFT', snapshot_hash: null })]),
      getStaffScorePeriod: setup.current ?? period(),
      listStaffScoreSignals: setup.signals ?? signals(),
    },
    { computeStaffScorePeriod: preview(), lockStaffScorePeriod: ok, officializeStaffScorePeriod: { ...ok, status: 'OFFICIAL' }, ...setup.commands },
  );
  const path = setup.path ?? `/pwf/pwf-14?id=${PERIOD_ID}`;
  if (setup.mode === undefined) mount(<PeriodScreen route={route} />, h, setup.permissions ?? SCORE_ALL, path);
  else mountAs(<PeriodScreen route={route} />, h, { permissions: setup.permissions ?? SCORE_ALL, mode: setup.mode, path });
  return h;
};

const detail = async () => screen.findByTestId('period-detail');

describe('PWF-14: the period', () => {
  it('shows the hash of the snapshot, the window of response, the open responses and the policy of a locked period', async () => {
    open();
    const facts = await detail();
    expect(within(facts).getByTestId('snapshot-hash').textContent).toBe(HASH);
    expect(within(facts).getByTestId('window').textContent).toBe('15/01/2027');
    expect(within(facts).getByTestId('open-responses').textContent).toBe('1');
    expect(within(facts).getByText(text('pwfs.period.facts.policy.text', { policy: 'DEFAULT', version: 2 }))).toBeTruthy();
    expect(screen.getByTestId('support-notice')).toBeTruthy();
  });

  it('lists the periods and links each one', async () => {
    open();
    await detail();
    const list = screen.getAllByRole('table')[0] as HTMLElement;
    expect(within(list).getAllByRole('link').map((link) => link.getAttribute('href'))).toContain(`/pwf/pwf-14?id=${uuid(5001)}`);
  });

  it('says a period that is not there, or not in scope, in words', async () => {
    open({ current: refusal('RESOURCE_NOT_FOUND', 404) });
    expect((await screen.findByTestId('period-error')).textContent).toBe(text('pwfs.period.notFound.notice'));
  });
});

describe('PWF-14: computing a draft', () => {
  const fill = (over: Partial<Record<'unitId' | 'from' | 'to' | 'policy', string>> = {}) => {
    const values = { unitId: UNIT, from: '2026-10-01', to: '2026-12-31', policy: 'DEFAULT', ...over };
    for (const [name, value] of Object.entries(values)) fireEvent.change(screen.getByTestId(`field-${name}`), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.compute.action') }));
  };

  it('refuses an incomplete form in words and sends nothing', async () => {
    const h = open({ path: '/pwf/pwf-14' });
    await screen.findByTestId('compute-form');
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.compute.action') }));
    expect(await screen.findByTestId('error-unitId')).toBeTruthy();
    expect(screen.getByTestId('error-from')).toBeTruthy();
    expect(screen.getByTestId('error-to')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the unit, the days and the policy, shows the preview and opens the new period', async () => {
    const h = open({ path: '/pwf/pwf-14' });
    await screen.findByTestId('compute-form');
    fill();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('computeStaffScorePeriod', expect.objectContaining({ body: { scope_unit_id: UNIT, period_from: '2026-10-01', period_to: '2026-12-31', policy_code: 'DEFAULT' } }));
    const result = await screen.findByTestId('preview');
    expect(within(result).getByTestId('preview-hash').textContent).toBe(HASH.slice(0, 16));
    expect(within(result).getByText('5')).toBeTruthy();
  });

  it.each([
    ['STAFF_SCORE_PERIOD_OVERLAP', 'pwfs.problem.periodOverlap.error'],
    ['STAFF_SCORE_SHARE_INVALID', 'pwfs.problem.shareInvalid.error'],
    ['CALENDAR_NOT_EFFECTIVE', 'pwfs.problem.calendarNotEffective.error'],
  ])('says in words that the server refused with %s', async (code, key) => {
    open({ path: '/pwf/pwf-14', commands: { computeStaffScorePeriod: refusal(code, 422) } });
    await screen.findByTestId('compute-form');
    fill();
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key));
  });

  it('is not offered to a membership that cannot manage periods', async () => {
    open({ permissions: ['staff_score.read_unit', 'pwf.read'], path: '/pwf/pwf-14' });
    await screen.findByRole('table');
    expect(screen.queryByTestId('compute-form')).toBeNull();
  });
});

describe('PWF-14: locking and making official', () => {
  it('computes the draft again with the same unit, days and policy', async () => {
    const h = open({ current: period({ status: 'DRAFT', snapshot_hash: null, locked_at: null, response_until: null }) });
    await detail();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.recompute.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('computeStaffScorePeriod', expect.objectContaining({ body: { scope_unit_id: UNIT, period_from: '2026-10-01', period_to: '2026-12-31', policy_code: 'DEFAULT' } })));
  });

  it('asks for confirmation before locking and sends the version of the period as If-Match', async () => {
    const h = open({ current: period({ status: 'DRAFT', snapshot_hash: null, locked_at: null, response_until: null, version: 3 }) });
    await detail();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.lock.action') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(text('pwfs.period.lock.warning'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: text('pwfs.period.lock.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('lockStaffScorePeriod', expect.objectContaining({ path: { id: PERIOD_ID }, ifMatchVersion: 3 })));
  });

  it('can be cancelled without sending anything', async () => {
    const h = open({ current: period({ status: 'DRAFT', snapshot_hash: null }) });
    await detail();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.lock.action') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwfs.common.cancel.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });

  it('makes a locked period official with its version', async () => {
    const h = open({ current: period({ status: 'LOCKED', version: 6 }) });
    await detail();
    expect(screen.queryByRole('button', { name: text('pwfs.period.lock.action') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.officialize.action') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwfs.period.officialize.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('officializeStaffScorePeriod', expect.objectContaining({ ifMatchVersion: 6 })));
  });

  it('says the period is not ready when the server refuses to make it official', async () => {
    open({ current: period({ status: 'LOCKED' }), commands: { officializeStaffScorePeriod: refusal('STAFF_SCORE_PERIOD_LOCKED', 409) } });
    await detail();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.officialize.action') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwfs.period.officialize.confirm') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfs.problem.periodLocked.error'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers to read the newer version after a conflict', async () => {
    const h = open({ current: period({ status: 'DRAFT', snapshot_hash: null }), commands: { lockStaffScorePeriod: refusal('VERSION_CONFLICT', 409) } });
    await detail();
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.period.lock.action') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwfs.period.lock.confirm') }));
    fireEvent.click(await screen.findByRole('button', { name: text('pwfs.common.reload.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'getStaffScorePeriod').length).toBeGreaterThan(1));
  });

  it('shows no button that writes to a read-only session, nor to a membership without the manage right', async () => {
    open({ mode: 'READ_ONLY', current: period({ status: 'LOCKED' }) });
    await detail();
    expect(screen.queryByRole('button', { name: text('pwfs.period.officialize.action') })).toBeNull();
    cleanup();
    open({ permissions: ['staff_score.read_unit', 'staff_score.review'], current: period({ status: 'LOCKED' }) });
    await detail();
    expect(screen.queryByRole('button', { name: text('pwfs.period.officialize.action') })).toBeNull();
  });
});

describe('PWF-14: the signals for the reviewers', () => {
  it('lists who was flagged and what for, and says flags change nothing', async () => {
    const h = open();
    const list = await screen.findByTestId('signals');
    expect(h.read).toHaveBeenCalledWith('listStaffScoreSignals', expect.objectContaining({ path: { id: PERIOD_ID } }));
    expect(within(list).getByText('Người 1')).toBeTruthy();
    expect(within(list).getByText(text('pwfs.flag.cancelledShare.word'))).toBeTruthy();
    expect(screen.getByTestId('flags-note').textContent).toBe(text('pwfs.flag.neverChanges.note'));
  });

  it('says there is no signal when there is none', async () => {
    open({ signals: signals({ items: [] }) });
    expect((await screen.findByTestId('no-signals')).textContent).toBe(text('pwfs.period.signals.none.text'));
  });

  it('shows nothing of the signals, and does not ask, to a membership without the review right', async () => {
    const h = open({ permissions: ['staff_score.manage'] });
    await detail();
    expect(screen.queryByTestId('signals')).toBeNull();
    expect(h.read).not.toHaveBeenCalledWith('listStaffScoreSignals', expect.anything());
  });
});

describe('PWF-14: the states', () => {
  it('is denied without asking for a membership with no right over periods', () => {
    const h = open({ permissions: ['staff_score.read_own'] });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the error state when the periods cannot be read', async () => {
    open({ list: refusal('INTERNAL', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await detail();
    await screen.findByTestId('signals');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
