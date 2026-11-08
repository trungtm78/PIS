import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import base from '../../i18n/vi.json';
import { harness, mount, never, routeOf, sha, uuid } from '../rpt/test/support';
import PeriodLockScreen from './rpt/PeriodLockScreen';

const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const fill = (key: string, params: Record<string, string | number>): string => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));
const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

const route = routeOf('RPT-06', 'FR-RPT-06');
const AS_OF = '2026-11-08T03:00:00.000Z';
const UNLOCKER = ['rpt.read', 'rpt.lock.read', 'rpt.lock.unlock'];
const rule = (over: Record<string, unknown> = {}) => ({ version: 0, unverified: true, lock_after: 'SIGNED', signature_required_receivers: ['MOF'], unlock_reason_min_chars: 15, ...over });
const lock = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  layout_code: 'MOF-DIS-MONTHLY',
  period_code: 'MONTH:2026-03',
  issue_id: uuid(n + 100),
  digest_sha256: sha('a'),
  locked_by: uuid(500),
  locked_at: '2026-11-07T02:00:00.000Z',
  open: true,
  unlocked_by: null,
  unlocked_at: null,
  unlock_reason: null,
  version: 1,
  ...over,
});
const lockPage = (items: unknown[], over: Record<string, unknown> = {}) => ({ as_of: AS_OF, items, has_more: false, rule: rule(over) });
const signatureFacts = (issueId: string, provider: 'REMOTE_CA' | 'MOCK' | null) => ({
  as_of: AS_OF,
  issue_id: issueId,
  layout_code: 'MOF-DIS-MONTHLY',
  period_code: 'MONTH:2026-03',
  revision: 2,
  digest_sha256: sha('a'),
  signed: provider !== null,
  signature: provider === null ? null : { id: uuid(60), issue_id: issueId, digest_sha256: sha('a'), provider, signer_id: uuid(501), certificate_fingerprint: sha('b'), cms_sha256: sha('c'), counts_for_delivery: provider !== 'MOCK', signed_at: '2026-11-07T01:00:00.000Z' },
  open_session_id: null,
  period_lock: null,
  signature_required_receivers: ['MOF'],
});

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

describe('RPT-06, the period locks and the signatures', () => {
  const open = (answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, permissions = UNLOCKER) => {
    const h = harness(answer, command);
    mount(<PeriodLockScreen route={route} />, h, { permissions });
    return h;
  };
  const one = (over: Record<string, unknown> = {}, items: unknown[] = [lock(1)]) => (op: string) => (op === 'listReportPeriodLocks' ? lockPage(items, over) : {});

  it('UI-RPT-06: lists the locks with the form, the period, the whole hash, who locked and the state', async () => {
    const h = open(one({}, [lock(1), lock(2, { open: false, unlocked_by: uuid(502), unlocked_at: '2026-11-08T01:00:00.000Z', unlock_reason: 'The Ministry asked for a correction of March', period_code: 'MONTH:2026-02' })]));
    expect(await screen.findByText('MONTH:2026-03')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('rpt.lock.page.title'));
    expect(screen.getAllByText(sha('a'))).toHaveLength(2);
    expect(screen.getByText(word('rpt.lock.state.locked'))).toBeTruthy();
    expect(screen.getByText(word('rpt.lock.state.released'))).toBeTruthy();
    expect(screen.getByText('The Ministry asked for a correction of March')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('listReportPeriodLocks', expect.objectContaining({ query: expect.objectContaining({ open_only: true }) }));
  });

  it('shows the figures of the rule with an "i" and says they are a default nobody confirmed', async () => {
    open(one());
    const min = await screen.findByTestId('rule-minchars');
    expect(min.textContent).toContain(fill('rpt.lock.rule.minChars', { count: 15 }));
    expect(screen.getByTestId('rule-count').textContent).toContain(fill('rpt.lock.rule.count', { count: 1 }));
    expect(within(screen.getByTestId('rule')).getByText(word('rpt.lock.info.unverified'))).toBeTruthy();
    fireEvent.click(within(min).getByRole('button', { name: fill('rpt.lock.info.open', { name: word('rpt.lock.rule.minChars.name') }) }));
    const panel = await screen.findByRole('dialog', { name: word('rpt.lock.rule.minChars.name') });
    expect(panel.textContent).toContain(word('rpt.lock.rule.minChars.formula'));
    expect(panel.textContent).toContain(word('rpt.lock.info.source.text'));
  });

  it('does not say "not confirmed" for a rule the tenant approved', async () => {
    open(one({ version: 3, unverified: false }));
    await screen.findByTestId('rule');
    expect(within(screen.getByTestId('rule')).queryByText(word('rpt.lock.info.unverified'))).toBeNull();
  });

  it('asks for a reason of the length of the rule and sends the version of the lock with the unlock', async () => {
    const h = open(one(), () => ({ operation_id: 'o', status: 'UNLOCKED', resource_version: 2, resource_id: uuid(1) }));
    fireEvent.click(await screen.findByTestId(`unlock-${uuid(1)}`));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: word('rpt.lock.unlock.confirm') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByLabelText(new RegExp(word('rpt.lock.unlock.reason')));
    fireEvent.change(reason, { target: { value: 'too short' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'The Ministry asked for a correction of March' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('unlockReportPeriod', expect.objectContaining({ path: { id: uuid(1) }, ifMatchVersion: 1, body: { reason: 'The Ministry asked for a correction of March' } })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'rpt.lock.error.selfApproval'],
    ['PERIOD_LOCK_NOT_FOUND', 404, 'rpt.lock.error.lockNotFound'],
    ['VERSION_CONFLICT', 409, 'rpt.lock.error.versionConflict'],
  ])('says the refusal %s in words inside the dialog', async (code, status, key) => {
    open(one(), () => problem(code, status));
    fireEvent.click(await screen.findByTestId(`unlock-${uuid(1)}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(word('rpt.lock.unlock.reason'))), { target: { value: 'The Ministry asked for a correction of March' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('rpt.lock.unlock.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word(key));
  });

  it('hides the unlock action from a person without the right and from a lock that is already released', async () => {
    open(one({}, [lock(1), lock(2, { open: false, unlocked_by: uuid(502), unlocked_at: '2026-11-08T01:00:00.000Z', unlock_reason: 'The Ministry asked for a correction of March' })]), undefined, ['rpt.read', 'rpt.lock.read']);
    expect(await screen.findByTestId(`no-unlock-${uuid(1)}`)).toBeTruthy();
    expect(screen.queryByTestId(`unlock-${uuid(1)}`)).toBeNull();
    expect(screen.queryByTestId(`unlock-${uuid(2)}`)).toBeNull();
    cleanup();
    open(one({}, [lock(2, { open: false, unlocked_by: uuid(502), unlocked_at: '2026-11-08T01:00:00.000Z', unlock_reason: 'The Ministry asked for a correction of March' })]));
    await screen.findByText('MONTH:2026-03');
    expect(screen.queryByTestId(`unlock-${uuid(2)}`)).toBeNull();
  });

  it('shows the signature of a copy with the whole digest, the hash of the CMS and that it counts for the Ministry', async () => {
    open((op, input) => (op === 'getReportSignature' ? signatureFacts((input as { path: { id: string } }).path.id, 'REMOTE_CA') : lockPage([lock(1)])));
    fireEvent.click(await screen.findByTestId(`signature-${uuid(1)}`));
    const detail = await screen.findByTestId('signature-detail');
    await within(detail).findByTestId('sig-digest');
    expect(within(detail).getByTestId('sig-digest').textContent).toBe(sha('a'));
    expect(within(detail).getByTestId('sig-cms').textContent).toBe(sha('c'));
    expect(within(detail).getByTestId('sig-counts').textContent).toBe(word('rpt.lock.detail.counts.yes'));
    expect(within(detail).getByTestId('sig-provider').textContent).toBe(word('rpt.lock.provider.remoteCa'));
    expect(within(detail).queryByTestId('test-signature')).toBeNull();
  });

  it('says a test signature does not count for the Ministry', async () => {
    open((op, input) => (op === 'getReportSignature' ? signatureFacts((input as { path: { id: string } }).path.id, 'MOCK') : lockPage([lock(1)])));
    fireEvent.click(await screen.findByTestId(`signature-${uuid(1)}`));
    expect((await screen.findByTestId('test-signature')).textContent).toBe(word('rpt.lock.detail.testNote'));
    expect(screen.getByTestId('sig-counts').textContent).toBe(word('rpt.lock.detail.counts.no'));
  });

  it('shows a copy that is not signed yet', async () => {
    open((op, input) => (op === 'getReportSignature' ? signatureFacts((input as { path: { id: string } }).path.id, null) : lockPage([lock(1)])));
    fireEvent.click(await screen.findByTestId(`signature-${uuid(1)}`));
    await screen.findByTestId('signature-detail');
    expect((await screen.findAllByText(word('rpt.lock.signature.unsigned'))).length).toBeGreaterThan(0);
  });

  it('filters by the form and refuses a code that is not one', async () => {
    const h = open(one());
    await screen.findByText('MONTH:2026-03');
    fireEvent.change(screen.getByTestId('filter-layout'), { target: { value: 'bad code!' } });
    expect((await screen.findByTestId('layout-invalid')).textContent).toBe(word('rpt.lock.filter.layout.invalid'));
    fireEvent.change(screen.getByTestId('filter-layout'), { target: { value: 'MOF-DIS-MONTHLY' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listReportPeriodLocks', expect.objectContaining({ query: expect.objectContaining({ layout_code: 'MOF-DIS-MONTHLY' }) })));
    fireEvent.click(screen.getByTestId('open-only'));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listReportPeriodLocks', expect.objectContaining({ query: expect.objectContaining({ open_only: false }) })));
  });

  it('shows the loading, empty, error and denied states', async () => {
    open(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open(one({}, []));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});
