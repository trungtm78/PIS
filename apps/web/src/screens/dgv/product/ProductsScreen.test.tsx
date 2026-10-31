import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, client, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import ProductsScreen from './ProductsScreen';
import { EMPTY_DECISION, badgeOf, decisionBody, decisionsAfter, describeDecision, evidenceLines, hasRunOut, holds, readinessOf, toProducts, validateDecision } from './model';
import type { ProductView } from './model';

const ROUTE = routeOf('DGV-18', 'FR-DGV-18');
const CERTIFIER = ['data.catalog.read', 'data.product.certify'];
const OK = { operation_id: 'o', status: 'CERTIFIED', resource_version: 2, resource_id: 'x' };
const TODAY = '2026-10-31';

const dataset = (n: number, overrides: Record<string, unknown> = {}) => ({ id: `00000000-0000-4000-8000-0000000000d${n}`, dataset_code: `DS-${n}`, title: `Dataset ${n}`, contract_published: true, quality_badge: 'PASSED', ...overrides });
const product = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000c${n}`,
  code: `PRODUCT-${n}`,
  title: `Actual Kho bac ${n}`,
  owner: { membership_id: '00000000-0000-4000-8000-000000000001', display_name: 'Nguyen Van An' },
  datasets: [dataset(1)],
  datasets_hidden: 0,
  certification_status: 'NOT_ASSESSED',
  certified_by: null,
  certified_at: null,
  certification_expires_on: null,
  evidence_count: 0,
  revoke_reason: null,
  version: 1,
  ...overrides,
});

afterEach(cleanup);

function open(items: unknown[], command: (operation: string, input: unknown) => unknown = () => OK, failing?: Error): Harness {
  const h = client(world(), command);
  h.read.mockImplementation((operation: string) => {
    if (operation !== 'listDataProducts') return Promise.reject(new Error(`unexpected read ${operation}`));
    return failing === undefined ? Promise.resolve({ items }) : Promise.reject(failing);
  });
  return h;
}

const show = (h: Harness, permissions: readonly string[] = CERTIFIER) => mount(<ProductsScreen route={ROUTE} />, h, permissions, '/dgv/dgv-18');
const sent = (h: Harness) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }) }));
const cardOf = async (n: number): Promise<HTMLElement> => {
  const cards = await screen.findAllByRole('article');
  const card = cards.find((item) => item.getAttribute('data-product') === product(n).id);
  if (card === undefined) throw new Error('the card is not shown');
  return card;
};

describe('ProductsScreen (DGV-18): the data products and their certification', () => {
  it('UI-DGV-18: shows each product with its status in words, the owner, the certifier and the last day, and the datasets with their contract and quality badge', async () => {
    const h = open([
      product(1),
      product(2, { certification_status: 'CERTIFIED', certified_by: { membership_id: '00000000-0000-4000-8000-000000000002', display_name: 'Tran Thi Binh' }, certification_expires_on: '2027-06-30', evidence_count: 2, datasets: [dataset(2), dataset(3, { contract_published: false, quality_badge: 'STALE' })] }),
      product(3, { certification_status: 'REVOKED', revoke_reason: 'The source was withdrawn by the Treasury.' }),
    ]);
    show(h, ['data.catalog.read']);
    const first = await cardOf(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dgv.product.page.title']);
    expect(within(first).getByTestId('status').textContent).toBe(vi_['dgv.product.status.notAssessed']);
    expect(first.textContent).toContain('Nguyen Van An');
    const second = await cardOf(2);
    expect(within(second).getByTestId('status').textContent).toBe(vi_['dgv.product.status.certified']);
    expect(within(second).getByTestId('certified-by').textContent).toBe('Tran Thi Binh');
    expect(within(second).getByTestId('expires').textContent).toBe('2027-06-30');
    const rows = within(second).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(vi_['dgv.product.dataset.published']);
    expect(rows[1]?.textContent).toContain(vi_['dgv.product.dataset.notPublished']);
    expect(rows[1]?.querySelector('[data-badge]')?.getAttribute('data-badge')).toBe('STALE');
    expect(within(second).getByTestId('readiness').textContent).toBe(vi_['dgv.product.ready.summary'].replace('{contract}', vi_['dgv.product.ready.blocked']).replace('{quality}', vi_['dgv.product.ready.blocked']));
    const third = await cardOf(3);
    expect(within(third).getByTestId('revoke-reason').textContent).toBe(vi_['dgv.product.revoked.reason'].replace('{reason}', 'The source was withdrawn by the Treasury.'));
    expect(within(third).queryByTestId('readiness')).toBeNull();
    // Somebody who may not certify decides nothing.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says that datasets the caller may not see still count, and leaves the readiness unknown while the ones seen are fine', async () => {
    const h = open([product(1, { datasets_hidden: 2 })]);
    show(h, ['data.catalog.read']);
    const card = await cardOf(1);
    expect(within(card).getByTestId('hidden').textContent).toBe(vi_['dgv.product.hidden.notice'].replace('{count}', '2'));
    expect(within(card).getByTestId('readiness').textContent).toBe(vi_['dgv.product.ready.summary'].replace('{contract}', vi_['dgv.product.ready.unknown']).replace('{quality}', vi_['dgv.product.ready.unknown']));
  });

  it('offers the decisions the status allows: certify or mark provisional at first, certify after, renew or revoke a certification, nothing after a revocation', async () => {
    const h = open([product(1), product(2, { certification_status: 'PROVISIONAL' }), product(3, { certification_status: 'CERTIFIED', certification_expires_on: '2999-01-01', evidence_count: 1 }), product(4, { certification_status: 'REVOKED', revoke_reason: 'x'.repeat(12) })]);
    show(h);
    const names = async (n: number): Promise<string[]> => within(await cardOf(n)).queryAllByRole('button').map((button) => button.textContent ?? '');
    expect(await names(1)).toEqual([vi_['dgv.product.action.provisional'], vi_['dgv.product.action.certify']]);
    expect(await names(2)).toEqual([vi_['dgv.product.action.certify']]);
    expect(await names(3)).toEqual([vi_['dgv.product.action.renew'], vi_['dgv.product.action.revoke']]);
    expect(await names(4)).toEqual([]);
  });

  it('UAT-AC495: asks for a reason, evidence and a last day before it asks the server, then sends the decision against the version it read', async () => {
    const h = open([product(1, { version: 4 })]);
    show(h);
    fireEvent.click(within(await cardOf(1)).getByRole('button', { name: vi_['dgv.product.action.certify'] }));
    const form = await screen.findByRole('form', { name: vi_['dgv.product.form.certify'] });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.product.form.submit.action'] }));
    expect(await within(form).findAllByText(vi_['dgv.product.field.required.error'])).toHaveLength(3);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['dgv.product.field.reason.label']), { target: { value: 'short' } });
    fireEvent.change(within(form).getByLabelText(vi_['dgv.product.field.evidence.label']), { target: { value: 'run 2026-10-30\n\n  minutes of the board  ' } });
    fireEvent.change(within(form).getByLabelText(vi_['dgv.product.field.expires.label']), { target: { value: '2020-01-01' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.product.form.submit.action'] }));
    expect(await within(form).findAllByText(vi_['dgv.product.field.invalid.error'])).toHaveLength(2);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['dgv.product.field.reason.label']), { target: { value: 'The contract is published and the run passed.' } });
    fireEvent.change(within(form).getByLabelText(vi_['dgv.product.field.expires.label']), { target: { value: '2999-06-30' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.product.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'certifyDataProduct',
      path: { id: product(1).id },
      ifMatchVersion: 4,
      body: { decision: 'CERTIFIED', reason: 'The contract is published and the run passed.', evidence_refs: [{ description: 'run 2026-10-30' }, { description: 'minutes of the board' }], certification_expires_on: '2999-06-30' },
    });
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['dgv.product.form.certify'] })).toBeNull());
  });

  it('sends a revocation with a reason alone, and a provisional mark without a last day', async () => {
    const h = open([product(1), product(2, { certification_status: 'CERTIFIED', certification_expires_on: '2999-01-01', evidence_count: 1, version: 3 })]);
    show(h);
    fireEvent.click(within(await cardOf(1)).getByRole('button', { name: vi_['dgv.product.action.provisional'] }));
    const provisional = await screen.findByRole('form', { name: vi_['dgv.product.form.provisional'] });
    expect(within(provisional).queryByLabelText(vi_['dgv.product.field.expires.label'])).toBeNull();
    fireEvent.change(within(provisional).getByLabelText(vi_['dgv.product.field.reason.label']), { target: { value: 'Waiting for the first run of the rules.' } });
    fireEvent.click(within(provisional).getByRole('button', { name: vi_['dgv.product.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]?.body).toEqual({ decision: 'PROVISIONAL', reason: 'Waiting for the first run of the rules.', evidence_refs: [] });
    fireEvent.click(within(await cardOf(2)).getByRole('button', { name: vi_['dgv.product.action.revoke'] }));
    const revoke = await screen.findByRole('form', { name: vi_['dgv.product.form.revoke'] });
    expect(within(revoke).queryByLabelText(vi_['dgv.product.field.evidence.label'])).toBeNull();
    fireEvent.change(within(revoke).getByLabelText(vi_['dgv.product.field.reason.label']), { target: { value: 'The source was withdrawn by the Treasury.' } });
    fireEvent.click(within(revoke).getByRole('button', { name: vi_['dgv.product.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(sent(h)[1]).toMatchObject({ ifMatchVersion: 3, body: { decision: 'REVOKED', reason: 'The source was withdrawn by the Treasury.', evidence_refs: [] } });
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'selfApproval'],
    ['QUALITY_NOT_PASSED', 422, 'qualityNotPassed'],
    ['CONTRACT_NOT_PUBLISHED', 422, 'contractNotPublished'],
    ['VERSION_CONFLICT', 409, 'stale'],
    ['PRODUCT_STATE_INVALID', 409, 'stateInvalid'],
    ['SCOPE_DENIED', 403, 'scopeDenied'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['VALIDATION_FAILED', 422, 'validation'],
    ['INTERNAL', 500, 'general'],
  ] as const)('says in words why the server refused with %s, and keeps the form open', async (code, status, problem) => {
    const h = open([product(1)], () => new ApiError({ status, code, correlationId: 'c' }));
    show(h);
    fireEvent.click(within(await cardOf(1)).getByRole('button', { name: vi_['dgv.product.action.provisional'] }));
    const form = await screen.findByRole('form', { name: vi_['dgv.product.form.provisional'] });
    fireEvent.change(within(form).getByLabelText(vi_['dgv.product.field.reason.label']), { target: { value: 'Waiting for the first run of the rules.' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.product.form.submit.action'] }));
    expect((await within(form).findByTestId('decision-refusal')).textContent).toBe(vi_[`dgv.product.problem.${problem}`]);
    expect(screen.getByRole('form', { name: vi_['dgv.product.form.provisional'] })).toBeTruthy();
  });

  it('shows a certification whose last day has gone as run out until the job turns it back', async () => {
    const h = open([product(1, { certification_status: 'CERTIFIED', certification_expires_on: '2020-01-01', evidence_count: 1 })]);
    show(h);
    const card = await cardOf(1);
    expect(within(card).getByTestId('run-out').textContent).toBe(vi_['dgv.product.runOut.notice'].replace('{day}', '2020-01-01'));
  });

  it('shows no form to a reader, closes the one that was open when it is chosen again, and says when the products could not be read', async () => {
    const h = open([product(1)]);
    show(h);
    const button = within(await cardOf(1)).getByRole('button', { name: vi_['dgv.product.action.certify'] });
    fireEvent.click(button);
    expect(await screen.findByRole('form', { name: vi_['dgv.product.form.certify'] })).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['dgv.product.form.certify'] })).toBeNull());
    cleanup();
    const failing = open([], undefined, new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }));
    show(failing, READER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of DGV-18', () => {
  const view = (overrides: Partial<ProductView> = {}): ProductView => ({
    id: 'x',
    code: 'P',
    title: 'T',
    owner: 'O',
    datasets: [],
    hidden: 0,
    status: 'NOT_ASSESSED',
    certifiedBy: null,
    expiresOn: null,
    evidenceCount: 0,
    revokeReason: null,
    version: 1,
    ...overrides,
  });

  it('reads a product and leaves out what is not one', () => {
    expect(toProducts(undefined)).toEqual([]);
    expect(toProducts({ items: [null, {}, product(1, { certification_status: 'UNKNOWN' }), { ...product(2), version: '1' }, product(3, { datasets: [null, dataset(1), { id: 'x' }], datasets_hidden: -1, certified_by: { membership_id: 'm' } })] })).toMatchObject([
      { code: 'PRODUCT-3', datasets: [{ datasetCode: 'DS-1' }], hidden: 0, certifiedBy: 'm' },
    ]);
  });

  it('reads an unknown badge as not assessed, never as a pass', () => {
    expect(badgeOf('PASSED')).toBe('PASSED');
    expect(badgeOf('GREAT')).toBe('NOT_ASSESSED');
  });

  it('follows the lines of the design for the decisions', () => {
    expect(decisionsAfter('NOT_ASSESSED')).toEqual(['PROVISIONAL', 'CERTIFIED']);
    expect(decisionsAfter('PROVISIONAL')).toEqual(['CERTIFIED']);
    expect(decisionsAfter('CERTIFIED')).toEqual(['CERTIFIED', 'REVOKED']);
    expect(decisionsAfter('REVOKED')).toEqual([]);
  });

  it('knows a certification has run out only after its last day', () => {
    const certified = view({ status: 'CERTIFIED', expiresOn: TODAY });
    expect(hasRunOut(certified, TODAY)).toBe(false);
    expect(hasRunOut(certified, '2026-11-01')).toBe(true);
    expect(hasRunOut(view({ status: 'PROVISIONAL', expiresOn: '2020-01-01' }), TODAY)).toBe(false);
    expect(hasRunOut(view({ status: 'CERTIFIED' }), TODAY)).toBe(false);
  });

  it('judges the readiness of the datasets seen, a blocking one winning over the unknown ones', () => {
    const ok = { id: 'a', datasetCode: 'A', title: '', contractPublished: true, qualityBadge: 'PASSED' };
    expect(readinessOf(view({ datasets: [ok] }))).toEqual({ contract: 'ready', quality: 'ready' });
    expect(readinessOf(view({ datasets: [ok], hidden: 1 }))).toEqual({ contract: 'unknown', quality: 'unknown' });
    expect(readinessOf(view({ datasets: [{ ...ok, contractPublished: false }, ok], hidden: 1 }))).toEqual({ contract: 'blocked', quality: 'unknown' });
    expect(readinessOf(view({ datasets: [{ ...ok, qualityBadge: 'STALE' }] }))).toEqual({ contract: 'ready', quality: 'blocked' });
  });

  it('validates a decision: a certification needs a reason, evidence and a real day after today; the other decisions need a reason only', () => {
    const good = { reason: 'The contract is published.', evidence: 'run 1', expiresOn: '2027-06-30' };
    expect(validateDecision('CERTIFIED', good, TODAY)).toEqual({});
    expect(validateDecision('CERTIFIED', EMPTY_DECISION, TODAY)).toEqual({ reason: 'required', evidence: 'required', expiresOn: 'required' });
    expect(validateDecision('CERTIFIED', { ...good, reason: 'x'.repeat(2001) }, TODAY)).toEqual({ reason: 'invalid' });
    expect(validateDecision('CERTIFIED', { ...good, evidence: 'x'.repeat(1001) }, TODAY)).toEqual({ evidence: 'invalid' });
    expect(validateDecision('CERTIFIED', { ...good, evidence: Array.from({ length: 501 }, () => 'x').join('\n') }, TODAY)).toEqual({ evidence: 'invalid' });
    for (const expiresOn of [TODAY, '2026-10-30', '2027-02-30', '2027-13-01', '30/06/2027']) expect(validateDecision('CERTIFIED', { ...good, expiresOn }, TODAY)).toEqual({ expiresOn: 'invalid' });
    expect(validateDecision('REVOKED', { ...EMPTY_DECISION, reason: 'The source was withdrawn.' }, TODAY)).toEqual({});
    expect(validateDecision('PROVISIONAL', { ...EMPTY_DECISION, reason: 'Waiting for the first run.' }, TODAY)).toEqual({});
    expect(validateDecision('PROVISIONAL', { reason: 'Waiting for the first run.', evidence: Array.from({ length: 501 }, () => 'x').join('\n'), expiresOn: '' }, TODAY)).toEqual({ evidence: 'invalid' });
  });

  it('builds the body of a decision: evidence a line, the day only for a certification, no evidence for a revocation', () => {
    const form = { reason: ' The contract is published. ', evidence: ' a \n\n b ', expiresOn: ' 2027-06-30 ' };
    expect(evidenceLines(form)).toEqual(['a', 'b']);
    expect(decisionBody('CERTIFIED', form)).toEqual({ decision: 'CERTIFIED', reason: 'The contract is published.', evidence_refs: [{ description: 'a' }, { description: 'b' }], certification_expires_on: '2027-06-30' });
    expect(decisionBody('PROVISIONAL', form)).toEqual({ decision: 'PROVISIONAL', reason: 'The contract is published.', evidence_refs: [{ description: 'a' }, { description: 'b' }] });
    expect(decisionBody('REVOKED', form)).toEqual({ decision: 'REVOKED', reason: 'The contract is published.', evidence_refs: [] });
  });

  it('holds a right only outside the read-only mode, and treats a caller with no list of rights as holding it', () => {
    expect(holds(['x'], 'x', 'FULL')).toBe(true);
    expect(holds(['x'], 'x', 'READ_ONLY')).toBe(false);
    expect(holds(['y'], 'x', 'FULL')).toBe(false);
    expect(holds(undefined, 'x', undefined)).toBe(true);
  });

  it('reads anything but an error of the server as a general failure', () => {
    expect(describeDecision(new Error('boom'))).toBe('general');
    expect(describeDecision(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' }))).toBe('general');
  });
});
