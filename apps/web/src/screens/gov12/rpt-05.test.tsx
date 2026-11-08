import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import base from '../../i18n/vi.json';
import { catalogue, entry, harness, issue, mount, never, page, routeOf, sha, uuid } from '../rpt/test/support';
import MofFormsScreen from './rpt/MofFormsScreen';

const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const fill = (key: string, params: Record<string, string | number>): string => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));
const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

const MEMBER = '00000000-0000-4000-8000-000000000001';
const SIGNER = ['rpt.read', 'rpt.sign'];
const route = routeOf('RPT-05', 'FR-RPT-05');
const AS_OF = '2026-11-08T03:00:00.000Z';

const mof = (code: string, over: Record<string, unknown> = {}) => entry({ code, name: `Form ${code}`, version: '2026.0', status: 'PENDING_EXTERNAL', official: 'PENDING_EXTERNAL', form_ref: null, receiver: 'MOF', period_kind: 'MONTH', issuable: false, ...over });
const FORMS = [mof('MOF-DIS-WEEKLY', { period_kind: 'AS_OF' }), mof('MOF-DIS-MONTHLY'), mof('MOF-DIS-QUARTERLY', { period_kind: 'QUARTER' }), mof('MOF-DIS-YEARLY', { period_kind: 'YEAR' }), entry()];
const copy = issue(31, { layout_code: 'MOF-DIS-MONTHLY', period_code: '2026-03', sha256: sha('e') });
const rule = (over: Record<string, unknown> = {}) => ({ version: 0, unverified: true, lock_after: 'SIGNED', signature_required_receivers: ['MOF'], unlock_reason_min_chars: 15, ...over });
const lockPage = (items: unknown[] = [], over: Record<string, unknown> = {}) => ({ as_of: AS_OF, items, has_more: false, rule: rule(over) });
const facts = (over: Record<string, unknown> = {}) => ({ as_of: AS_OF, issue_id: copy.id, layout_code: 'MOF-DIS-MONTHLY', period_code: '2026-03', revision: 1, digest_sha256: sha('e'), signed: false, signature: null, open_session_id: null, period_lock: null, signature_required_receivers: ['MOF'], ...over });
const signature = (provider: 'REMOTE_CA' | 'MOCK') => ({ id: uuid(60), issue_id: copy.id, digest_sha256: sha('e'), provider, signer_id: MEMBER, certificate_fingerprint: sha('f'), cms_sha256: sha('9'), counts_for_delivery: provider !== 'MOCK', signed_at: '2026-11-07T04:00:00.000Z' });
const certificate = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(n), kind: 'PERSONAL', holder_membership_id: MEMBER, fingerprint_sha256: sha('f'), subject_dn: `CN=Signer ${n}`, status: 'Active', valid_until: '2027-01-01T00:00:00.000Z', ...over });

interface World {
  forms?: unknown;
  issues?: unknown;
  locks?: unknown;
  facts?: unknown;
  certificates?: unknown;
}
const world = (w: World = {}) => (op: string): unknown => {
  switch (op) {
    case 'listReportCatalogue':
      return w.forms ?? catalogue(FORMS);
    case 'listReportIssues':
      return w.issues ?? page([copy]);
    case 'listReportPeriodLocks':
      return w.locks ?? lockPage();
    case 'getReportSignature':
      return w.facts ?? facts();
    case 'get_resources_signing_certificate':
      return w.certificates ?? { items: [certificate(70), certificate(71, { holder_membership_id: uuid(999), subject_dn: 'CN=Someone else' }), certificate(72, { status: 'Revoked', subject_dn: 'CN=Revoked' })] };
    default:
      return {};
  }
};

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

describe('RPT-05, the forms for the Ministry of Finance', () => {
  const open = (w: World = {}, command?: (op: string, input: unknown) => unknown, permissions = SIGNER) => {
    const h = harness(world(w), command);
    mount(<MofFormsScreen route={route} />, h, { permissions });
    return h;
  };

  it('UI-RPT-05: lists the four forms for the Ministry only, each waiting for its official template and not issuable', async () => {
    open();
    for (const code of ['MOF-DIS-WEEKLY', 'MOF-DIS-MONTHLY', 'MOF-DIS-QUARTERLY', 'MOF-DIS-YEARLY']) expect(await screen.findByTestId(`form-${code}`)).toBeTruthy();
    expect(screen.queryByTestId('form-DIS-WEEKLY')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('rpt.mof.page.title'));
    expect(screen.getByTestId('pending-MOF-DIS-YEARLY').textContent).toBe(word('rpt.mof.pending.text'));
    expect(screen.getAllByText(word('rpt.mof.issuable.no'))).toHaveLength(4);
  });

  it('shows the rule as figures with an "i" and says the numbers are a default nobody confirmed', async () => {
    open();
    const receivers = await screen.findByTestId('rule-receivers');
    expect(receivers.textContent).toContain(fill('rpt.mof.rule.receivers', { receivers: 'MOF' }));
    expect(screen.getByTestId('rule-lock').textContent).toContain(fill('rpt.mof.rule.lock', { event: word('rpt.mof.rule.lockAfter.signed') }));
    expect(screen.getByTestId('rule-open-locks').textContent).toContain(fill('rpt.mof.rule.openLocks', { count: 0 }));
    expect(within(screen.getByTestId('rule')).getByText(word('rpt.lock.info.unverified'))).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('rule-lock')).getByRole('button', { name: fill('rpt.lock.info.open', { name: word('rpt.mof.rule.lock.name') }) }));
    const panel = await screen.findByRole('dialog', { name: word('rpt.mof.rule.lock.name') });
    expect(panel.textContent).toContain(word('rpt.mof.rule.lock.formula'));
    expect(panel.textContent).toContain(word('rpt.lock.info.version.default'));
    expect(panel.textContent).toContain(word('rpt.lock.info.unverified'));
  });

  it('says there is no copy yet when nothing was issued', async () => {
    open({ issues: page([]) });
    expect((await screen.findByTestId('copies-empty')).textContent).toBe(word('rpt.mof.copies.empty'));
  });

  it('offers to sign an unsigned copy to the person who holds the right, and not to a reader', async () => {
    open();
    expect(await screen.findByTestId(`sign-${copy.id}`)).toBeTruthy();
    cleanup();
    open({}, undefined, ['rpt.read']);
    await screen.findByTestId(`copy-${copy.id}`);
    await waitFor(() => expect(screen.getByText(word('rpt.mof.action.noRight'))).toBeTruthy());
    expect(screen.queryByTestId(`sign-${copy.id}`)).toBeNull();
  });

  it('shows a test signature as one: it does not count for the Ministry and the copy cannot be signed again', async () => {
    open({ facts: facts({ signed: true, signature: signature('MOCK') }) });
    expect((await screen.findByTestId(`test-note-${copy.id}`)).textContent).toBe(word('rpt.mof.signature.testNote'));
    expect(screen.getByText(word('rpt.lock.signature.test'))).toBeTruthy();
    expect(screen.queryByTestId(`sign-${copy.id}`)).toBeNull();
  });

  it('shows a real signature and the lock of its period', async () => {
    open({ facts: facts({ signed: true, signature: signature('REMOTE_CA'), period_lock: { id: uuid(80), open: true } }) });
    expect(await screen.findByText(word('rpt.lock.signature.signed'))).toBeTruthy();
    expect(await screen.findByText(word('rpt.lock.state.locked'))).toBeTruthy();
  });

  it('starts a signature with an active certificate of the signer, then completes it', async () => {
    const command = vi.fn((op: string) => (op === 'startReportSignature' ? { operation_id: 'o', status: 'STARTED', resource_version: 1, resource_id: uuid(90) } : { operation_id: 'o', status: 'SIGNED', resource_version: 1, resource_id: copy.id }));
    const h = open({}, command);
    fireEvent.click(await screen.findByTestId(`sign-${copy.id}`));
    const picker = await screen.findByTestId('sign-certificate');
    // Only the active personal certificate of the signer is offered.
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    expect(within(picker).queryByText('CN=Someone else')).toBeNull();
    expect(within(picker).queryByText('CN=Revoked')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('rpt.mof.sign.start') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.mof.sign.certificate.invalid'));
    fireEvent.change(picker, { target: { value: uuid(70) } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.mof.sign.start') }));
    expect((await screen.findByTestId('sign-waiting')).textContent).toBe(word('rpt.mof.sign.started'));
    expect(h.command).toHaveBeenCalledWith('startReportSignature', expect.objectContaining({ body: { certificate_id: uuid(70) } }));
    fireEvent.click(screen.getByRole('button', { name: word('rpt.mof.sign.complete') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completeReportSignature', expect.objectContaining({ path: { id: uuid(90) } })));
    await waitFor(() => expect(screen.queryByTestId('sign-waiting')).toBeNull());
  });

  it('says it is waiting while the signer has not approved, and keeps the dialog open', async () => {
    const h = open({}, (op) => (op === 'startReportSignature' ? { operation_id: 'o', status: 'STARTED', resource_version: 1, resource_id: uuid(90) } : { operation_id: 'o', status: 'PENDING', resource_version: 1, resource_id: uuid(90) }));
    fireEvent.click(await screen.findByTestId(`sign-${copy.id}`));
    const picker = await screen.findByTestId('sign-certificate');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(picker, { target: { value: uuid(70) } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.mof.sign.start') }));
    await screen.findByTestId('sign-waiting');
    fireEvent.click(screen.getByRole('button', { name: word('rpt.mof.sign.complete') }));
    await waitFor(() => expect(screen.getByTestId('sign-waiting').textContent).toBe(word('rpt.mof.sign.waiting')));
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['CERTIFICATE_NOT_ACTIVE', 'rpt.lock.error.certificate'],
    ['PROVIDER_UNAVAILABLE', 'rpt.lock.error.provider'],
    ['SELF_APPROVAL_DENIED', 'rpt.lock.error.selfApproval'],
  ])('answers the refusal %s in words inside the dialog', async (code, key) => {
    open({}, () => problem(code, code === 'PROVIDER_UNAVAILABLE' ? 503 : 422));
    fireEvent.click(await screen.findByTestId(`sign-${copy.id}`));
    const picker = await screen.findByTestId('sign-certificate');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(picker, { target: { value: uuid(70) } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.mof.sign.start') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word(key));
  });

  it('asks for the certificate id by hand when the certificates cannot be read', async () => {
    open({ certificates: problem('SCOPE_DENIED', 403) });
    fireEvent.click(await screen.findByTestId(`sign-${copy.id}`));
    expect(await screen.findByTestId('sign-certificate-id')).toBeTruthy();
  });

  it('shows the loading, empty, error and denied states', async () => {
    open({ forms: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ forms: catalogue([entry()]) });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open({ forms: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ forms: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });

  it('says the rule could not be read when the person may not see period locks, and the copies could not be loaded on an error', async () => {
    open({ locks: problem('SCOPE_DENIED', 403), issues: problem('INTERNAL_ERROR', 500) });
    await waitFor(() => expect(screen.getByTestId('rule-unknown').textContent).toBe(word('rpt.mof.rule.unreadable')));
    expect((await screen.findByTestId('copies-error')).textContent).toContain(word('rpt.mof.copies.error'));
  });
});
