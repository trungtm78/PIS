import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import part from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import PublicationInboxScreen from './PublicationInboxScreen';
import { SignOffBlock } from './SignOffBlock';
import { checkBody, toRequest } from './publication-model';
import { toDashboard, toSignOff, toVersion } from './dashboard-model';
import type { SignOff } from './dashboard-model';
import vi_ from '../../i18n/vi.json';

const INBOX = routeOf('BI-11', 'FR-BI-11');
const APPROVE = ['bi.publish', 'bi.query', 'dashboard_version.read', 'metric_definition.read'];
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const R1 = '00000000-0000-4000-8000-0000000000a1';
const D1 = '00000000-0000-4000-8000-0000000000e1';
const V1 = '00000000-0000-4000-8000-0000000000f1';

const raw = (overrides: Record<string, unknown> = {}) => ({
  version_id: V1,
  revision: 2,
  prepared_by: { id: OTHER, name: 'Lan', at: '2026-11-01T01:00:00.000Z' },
  checked_by: { id: ME, name: 'Minh', at: '2026-11-02T01:00:00.000Z' },
  approved_by: { id: OTHER, name: null, at: '2026-11-03T01:00:00.000Z' },
  state: 'APPROVED',
  complete: true,
  ...overrides,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  id: R1,
  object_kind: 'DASHBOARD',
  object_id: V1,
  object_code: 'D-1',
  object_revision: 2,
  requested_by: { id: OTHER, name: 'Người đề nghị' },
  checks: [],
  status: 'PENDING',
  decision: null,
  decided_by: null,
  decided_at: null,
  comment: null,
  checked_by: null,
  checked_at: null,
  check_comment: null,
  created_at: '2026-11-01T01:00:00.000Z',
  version: 3,
  ...overrides,
});

afterEach(cleanup);

function inbox(requests: unknown[]) {
  const h = harness(() => new Error('unexpected read'), () => ({ operation_id: 'o', status: 'PENDING', resource_version: 4, resource_id: R1 }));
  (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => Promise.resolve(requests);
  return h;
}

describe('the signatures of a dashboard (BC.02)', () => {
  it('reads the block of a version and of a dashboard, and keeps a missing step as nothing', () => {
    expect(toSignOff(raw())).toEqual({
      versionId: V1,
      revision: 2,
      prepared: { id: OTHER, name: 'Lan', at: '2026-11-01T01:00:00.000Z' },
      checked: { id: ME, name: 'Minh', at: '2026-11-02T01:00:00.000Z' },
      approved: { id: OTHER, name: null, at: '2026-11-03T01:00:00.000Z' },
      state: 'APPROVED',
      complete: true,
    });
    expect(toSignOff(raw({ checked_by: null, complete: false }))).toMatchObject({ checked: null, complete: false });
    expect(toSignOff('nothing')).toBeNull();
    expect(toSignOff(raw({ state: 'NONSENSE' }))?.state).toBe('UNSIGNED');
    const version = toVersion({ id: V1, revision: 2, status: 'PUBLISHED', sign_off: raw() });
    expect(version?.signOff?.checked?.name).toBe('Minh');
    expect(toVersion({ id: V1 })?.signOff).toBeNull();
    const dashboard = toDashboard({ id: D1, code: 'D-1', sign_off: raw({ state: 'PREPARED' }), versions: [] });
    expect(dashboard?.signOff?.state).toBe('PREPARED');
    expect(toDashboard({ id: D1, code: 'D-1' })?.signOff).toBeNull();
  });

  it('prints the three names with the day, and says in words that the check was not taken and that the report is not fully signed', () => {
    const block: SignOff = toSignOff(raw({ checked_by: null, complete: false })) as SignOff;
    render(
      <SignOffBlock signOff={block} />,
    );
    const lines = screen.getByTestId('sign-off');
    expect(within(lines).getByTestId('sign-prepared').textContent).toContain('Lan');
    expect(within(lines).getByTestId('sign-prepared').textContent).toContain('2026-11-01');
    expect(within(lines).getByTestId('sign-checked').textContent).toContain(part['bi.sign.none']);
    // A person with no name in the directory is shown by their identifier, never by a made-up name.
    expect(within(lines).getByTestId('sign-approved').textContent).toContain(OTHER);
    expect(screen.getByTestId('sign-incomplete').textContent).toBe(part['bi.sign.incomplete']);
  });

  it('shows no warning when all three signed, and says there is nothing to sign for a dashboard without a version', () => {
    const { rerender } = render(
      <SignOffBlock signOff={toSignOff(raw()) as SignOff} />,
    );
    expect(screen.queryByTestId('sign-incomplete')).toBeNull();
    expect(screen.getByTestId('sign-complete').textContent).toBe(part['bi.sign.complete']);
    rerender(
      <SignOffBlock signOff={null} />,
    );
    expect(screen.getByTestId('sign-none').textContent).toBe(part['bi.sign.noVersion']);
  });
});

describe('the check step in the inbox of publications (BC.02)', () => {
  it('reads who checked a request and writes the body of the check', () => {
    expect(toRequest(request({ checked_by: { id: ME, name: 'Minh' }, checked_at: '2026-11-02T01:00:00.000Z', check_comment: 'Đã đối chiếu' }))).toMatchObject({
      checkedBy: { id: ME, name: 'Minh' },
      checkedAt: '2026-11-02T01:00:00.000Z',
      checkComment: 'Đã đối chiếu',
    });
    expect(toRequest(request())).toMatchObject({ checkedBy: null, checkedAt: null, checkComment: null });
    expect(checkBody('  ')).toEqual({});
    expect(checkBody(' Đã đối chiếu ')).toEqual({ comment: 'Đã đối chiếu' });
  });

  it('lets a person who did not ask mark the request as checked, under the version it was read at', async () => {
    const h = inbox([request()]);
    mount(<PublicationInboxScreen route={INBOX} />, h, { permissions: APPROVE });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    const panel = await screen.findByTestId('decide');
    await user.type(within(panel).getByLabelText(vi_['bi.pub.decide.comment']), ' Đã đối chiếu ');
    await user.click(within(panel).getByRole('button', { name: part['bi.sign.check.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('checkBiPublication', expect.objectContaining({ path: { id: R1 }, body: { comment: 'Đã đối chiếu' }, ifMatchVersion: 3 }));
  });

  it('shows who checked, and does not let the checker decide', async () => {
    const h = inbox([request({ checked_by: { id: ME, name: 'Tôi' }, checked_at: '2026-11-02T01:00:00.000Z' })]);
    mount(<PublicationInboxScreen route={INBOX} />, h, { permissions: APPROVE });
    const user = userEvent.setup();
    expect((await screen.findByTestId('checked')).textContent).toContain('Tôi');
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    const panel = await screen.findByTestId('decide');
    expect(within(panel).getByTestId('checker-self').textContent).toBe(part['bi.sign.check.self']);
    expect(within(panel).queryByRole('button', { name: part['bi.sign.check.action'] })).toBeNull();
    expect(within(panel).queryByRole('button', { name: vi_['bi.pub.decide.approve'] })).toBeNull();
  });
});
