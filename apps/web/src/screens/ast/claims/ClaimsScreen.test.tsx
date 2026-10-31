import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness } from '../../sas/test-support';
import { mount, routeOf } from '../handover/test-support';
import ClaimsScreen from './ClaimsScreen';

const ROUTE = routeOf('AST-05', 'FR-AST-05');
const OWNER = ['warranty.claim', 'warranty.read'];
const CONTRACTOR = ['warranty.respond', 'warranty.read'];
const VERIFIER = ['warranty.verify', 'warranty.read'];
const OBLIGATION = '00000000-0000-4000-8000-000000000a01';
const OTHER_OBLIGATION = '00000000-0000-4000-8000-000000000a02';
const CONTRACTOR_ID = '00000000-0000-4000-8000-0000000000c1';
const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';
const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const OK = { operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: 'new' };

const obligation = (id = OBLIGATION, overrides: Record<string, unknown> = {}) => ({
  id,
  contract: { id: 'k-1', code: 'HD-001' },
  contractor: { id: CONTRACTOR_ID, name: 'Nhà thầu An Phát' },
  handover: { id: 'h-1', handover_no: 'BG-001' },
  scope_description: 'Trạm bơm',
  starts_on: '2026-09-01',
  ends_on: '2027-09-01',
  status: 'ACTIVE',
  ...overrides,
});
const claim = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000b0${String(n).padStart(2, '0')}`,
  claim_no: `WC-00${n}`,
  obligation: { id: OBLIGATION, ends_on: '2027-09-01', status: 'ACTIVE' },
  contract: { id: 'k-1', code: 'HD-001' },
  handover: { id: 'h-1', handover_no: 'BG-001' },
  severity: 'MAJOR',
  defect_description: `Nứt tường ${n}`,
  location_text: null,
  responder: { id: CONTRACTOR_ID, name: 'Nhà thầu An Phát' },
  reported_on: '2027-01-10',
  response_due_on: '2027-01-17',
  committed_fix_on: null,
  fixed_on: null,
  cost_borne_by: 'UNDETERMINED',
  status: 'OPEN',
  overdue: false,
  issue: null,
  allowed: { acknowledge: false, fix: false, verify: false },
  created_at: `2027-01-10T01:00:0${n}.000000Z`,
  version: 1,
  ...overrides,
});

afterEach(cleanup);

interface World {
  claims?: unknown[];
  /** The claims as they stand each time the board asks: they can change between two reads. */
  claimsNow?: () => unknown[];
  obligations?: unknown[];
  failing?: Set<string>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(world: World = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; query?: string } = {}) {
  const state = { claims: world.claims ?? [], obligations: world.obligations ?? [obligation(), obligation(OTHER_OBLIGATION, { contract: { id: 'k-2', code: 'HD-002' } }), obligation('00000000-0000-4000-8000-000000000a03', { status: 'EXPIRED' })] };
  const h = harness(() => new Error('unexpected read'), world.command ?? (() => OK));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (world.failing?.has(operation)) return Promise.reject(new Error('down'));
    if (operation === 'listWarrantyClaims') return Promise.resolve(world.claimsNow === undefined ? state.claims : world.claimsNow());
    if (operation === 'listWarrantyObligations') return Promise.resolve(state.obligations);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  mount(<ClaimsScreen route={ROUTE} />, h, { permissions: options.permissions ?? OWNER, path: `/ast/ast-05${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const commandsOf = (h: ReturnType<typeof open>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path: { id: string }; body: Record<string, unknown>; ifMatchVersion?: number });
const readsOf = (h: ReturnType<typeof open>, operation: string): number => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === operation).length;
const lane = (name: string): HTMLElement => document.querySelector(`[data-lane="${name}"]`) as HTMLElement;
const dialog = async (): Promise<HTMLElement> => screen.findByRole('dialog');

describe('ClaimsScreen (AST-05): the claims against a warranty', () => {
  it('UI-AST-05: puts each claim in the column of its status with the severity, the contractor, the day to answer by, the day committed to, the cost and the issue', async () => {
    open({
      claims: [
        claim(1, { overdue: true, issue: { id: 'i-1', code: 'ISS-014' } }),
        claim(2, { status: 'ACKNOWLEDGED', committed_fix_on: '2027-01-25', severity: 'CRITICAL', version: 2 }),
        claim(3, { status: 'FIXED', fixed_on: '2027-01-24', severity: 'MINOR', version: 3 }),
        claim(4, { status: 'DISPUTED', version: 4 }),
        claim(5, { status: 'VERIFIED', cost_borne_by: 'OWNER', version: 4 }),
        claim(6, { status: 'CLOSED', cost_borne_by: 'CONTRACTOR', version: 5 }),
      ],
    });
    await screen.findByTestId('board');
    expect(['OPEN', 'IN_PROGRESS', 'FIXED', 'DISPUTED', 'VERIFIED'].map((name) => lane(name).querySelectorAll('[data-claim]').length)).toEqual([1, 1, 1, 1, 2]);
    expect(screen.getByTestId('count-VERIFIED').textContent).toBe('2');
    const first = lane('OPEN').querySelector('[data-claim]') as HTMLElement;
    expect(within(first).getByText('WC-001')).toBeTruthy();
    expect(within(first).getByText(text('ast.claims.severity.major'))).toBeTruthy();
    expect(within(first).getByTestId('responder').textContent).toBe('Nhà thầu An Phát');
    expect(within(first).getByTestId('due').textContent).toContain('2027-01-17');
    expect(within(first).getByTestId('overdue').textContent).toBe(text('ast.claims.card.overdue'));
    expect(within(first).getByTestId('issue').textContent).toBe('ISS-014');
    const progress = lane('IN_PROGRESS').querySelector('[data-claim]') as HTMLElement;
    expect(within(progress).getByText('2027-01-25')).toBeTruthy();
    expect(within(progress).getByText(text('ast.claims.severity.critical')).className).toBe('pill red');
    expect(Array.from(lane('VERIFIED').querySelectorAll('[data-testid="cost"]')).map((cell) => cell.textContent)).toEqual([text('ast.claims.bearer.owner'), text('ast.claims.bearer.contractor')]);
    expect(document.querySelector('[data-testid="overdue"]')).toBe(first.querySelector('[data-testid="overdue"]'));
    expect(document.querySelectorAll('[data-testid="issue"]')).toHaveLength(1);
  });

  it('shows the evidence of the report and of the repair and the notes of the contractor and of the verifier, so that a repair can be inspected and a dispute understood', async () => {
    open({
      claims: [
        claim(3, {
          status: 'DISPUTED',
          evidence_document_version_id: EVIDENCE,
          fix_evidence_document_version_id: '00000000-0000-4000-8000-0000000000e2',
          fix_evidence_photo_id: '00000000-0000-4000-8000-0000000000e3',
          fix_note: 'Đã trám lại',
          verification_note: 'Vết nứt vẫn còn',
        }),
        claim(4),
      ],
    });
    await screen.findByTestId('board');
    const card = lane('DISPUTED').querySelector('[data-claim]') as HTMLElement;
    expect(within(card).getByTestId('evidence').textContent).toBe(EVIDENCE);
    expect(within(card).getByTestId('fix-evidence').textContent).toBe('00000000-0000-4000-8000-0000000000e2 · 00000000-0000-4000-8000-0000000000e3');
    expect(within(card).getByTestId('fix-note').textContent).toBe('Đã trám lại');
    expect(within(card).getByTestId('verification-note').textContent).toBe('Vết nứt vẫn còn');
    const plain = lane('OPEN').querySelector('[data-claim]') as HTMLElement;
    for (const id of ['evidence', 'fix-evidence', 'fix-note', 'verification-note']) expect(within(plain).queryByTestId(id)).toBeNull();
  });

  it('says when there is no claim yet', async () => {
    open({ claims: [] });
    expect((await screen.findByTestId('empty')).textContent).toBe(text('ast.claims.empty.notice'));
  });

  it('UAT-AC390: files a claim on an obligation still running, addressed to the contractor of the contract, and reads the board again', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.file.action') }));
    const form = await dialog();
    expect(Array.from((document.getElementById('claim-obligation') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', OBLIGATION, OTHER_OBLIGATION]);
    pick('claim-obligation', OBLIGATION);
    expect(screen.getByTestId('file-addressee').textContent).toBe(text('ast.claims.file.addressee', { name: 'Nhà thầu An Phát', end: '2027-09-01' }));
    pick('claim-no', ' WC-001 ');
    pick('claim-reported', '2027-01-10');
    pick('claim-severity', 'MAJOR');
    pick('claim-defect', ' Nứt tường ');
    pick('claim-location', 'Tường bắc');
    fireEvent.submit(form.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(commandsOf(h, 'fileWarrantyClaim')).toHaveLength(1));
    expect(commandsOf(h, 'fileWarrantyClaim')[0]).toMatchObject({
      path: { id: OBLIGATION },
      body: { claim_no: 'WC-001', reported_on: '2027-01-10', defect_description: 'Nứt tường', severity: 'MAJOR', responder_contractor_id: CONTRACTOR_ID, location_text: 'Tường bắc' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(readsOf(h, 'listWarrantyClaims')).toBeGreaterThan(1));
  });

  it('starts the form on the obligation the board is filtered to, and filters the board by obligation', async () => {
    const h = open({}, { query: `?obligation=${OTHER_OBLIGATION}` });
    await waitFor(() => expect((document.getElementById('claims-filter') as HTMLSelectElement).value).toBe(OTHER_OBLIGATION));
    expect(h.client.readAll).toHaveBeenCalledWith('listWarrantyClaims', { query: { obligation_id: OTHER_OBLIGATION } });
    fireEvent.click(screen.getByRole('button', { name: text('ast.claims.file.action') }));
    await dialog();
    expect((document.getElementById('claim-obligation') as HTMLSelectElement).value).toBe(OTHER_OBLIGATION);
  });

  it('keeps the board filtered to an obligation that has run out or is closed, though no new claim is offered on it', async () => {
    const ended = '00000000-0000-4000-8000-000000000a03';
    const h = open({ claims: [claim(1)] }, { query: `?obligation=${ended}` });
    await screen.findByTestId('board');
    expect(h.client.readAll).toHaveBeenCalledWith('listWarrantyClaims', { query: { obligation_id: ended } });
    await waitFor(() => expect((document.getElementById('claims-filter') as HTMLSelectElement).value).toBe(ended));
    expect(screen.getByRole('option', { name: text('ast.claims.filter.ended') })).toBeTruthy();
  });

  it('sends the version the board shows now when the answer is tried again after a conflict, and drops the dialog once the claim has moved on', async () => {
    let current = claim(1, { allowed: { acknowledge: true, fix: false, verify: false }, version: 1 });
    let refuse = true;
    const h = open({ claimsNow: () => [current], obligations: [], command: () => (refuse ? problem('VERSION_CONFLICT', {}, 409) : OK) }, { permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.acknowledge') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    pick('claim-committed', '2027-01-25');
    // Somebody else changes the claim while the dialog is open.
    current = claim(1, { allowed: { acknowledge: true, fix: false, verify: false }, version: 2 });
    fireEvent.submit(form);
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('ast.claims.error.conflict'));
    refuse = false;
    await waitFor(() => expect(readsOf(h, 'listWarrantyClaims')).toBeGreaterThan(1));
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(commandsOf(h, 'acknowledgeWarrantyClaim')).toHaveLength(2));
    expect(commandsOf(h, 'acknowledgeWarrantyClaim').map((call) => call.ifMatchVersion)).toEqual([1, 2]);
  });

  it('removes the dialog when the claim is no longer there for the action', async () => {
    let current = claim(1, { allowed: { acknowledge: true, fix: false, verify: false }, version: 1 });
    open({ claimsNow: () => [current], obligations: [], command: () => problem('CLAIM_STATE_INVALID', {}, 409) }, { permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.acknowledge') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    pick('claim-committed', '2027-01-25');
    current = claim(1, { status: 'ACKNOWLEDGED', allowed: { acknowledge: false, fix: true, verify: false }, version: 2 });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(lane('IN_PROGRESS')).getByText('WC-001')).toBeTruthy();
  });

  it('names what is wrong before sending: no obligation, no number, no severity, no defect, a day outside the warranty', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.file.action') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect((await screen.findAllByText(text('ast.claims.problem.required'))).length).toBeGreaterThanOrEqual(4);
    pick('claim-obligation', OBLIGATION);
    pick('claim-no', 'WC-1');
    pick('claim-severity', 'MINOR');
    pick('claim-defect', 'Crack');
    pick('claim-reported', '2027-09-01');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.claims.problem.outside'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says in words why the server refused a claim, and keeps the dialog open', async () => {
    for (const [error, key] of [
      [problem('WARRANTY_EXPIRED'), 'expired'],
      [problem('CLAIM_NO_DUPLICATE', {}, 409), 'duplicate'],
      [problem('WARRANTY_STATE_INVALID', {}, 409), 'closed'],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_START' }), 'beforeStart'],
      [problem('VALIDATION_FAILED', { reason: 'NOT_A_PARTY' }), 'notParty'],
      [problem('VALIDATION_FAILED', { reason: 'NOT_IN_CONTRACT' }), 'evidenceInvalid'],
      [problem('DOCUMENT_NOT_CLEAN'), 'notClean'],
      [problem('SCOPE_DENIED', {}, 403), 'denied'],
      [problem('RESOURCE_NOT_FOUND', {}, 404), 'notFound'],
      [problem('INTERNAL_ERROR', {}, 500), 'general'],
    ] as const) {
      open({ command: () => error });
      fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.file.action') }));
      const form = (await dialog()).querySelector('form') as HTMLFormElement;
      pick('claim-obligation', OBLIGATION);
      pick('claim-no', 'WC-1');
      pick('claim-severity', 'MINOR');
      pick('claim-defect', 'Crack');
      fireEvent.submit(form);
      expect((await screen.findByTestId('refusal')).textContent).toBe(text(`ast.claims.error.${key}`));
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });

  it('UAT-AC391: the contractor answers an open claim with the day it commits to, at the version it saw', async () => {
    const h = open({ claims: [claim(1, { overdue: true, allowed: { acknowledge: true, fix: false, verify: false }, version: 1 })] }, { permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.acknowledge') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.claims.problem.required'))).toBeTruthy();
    pick('claim-committed', '2027-01-09');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.claims.problem.outside'))).toBeTruthy();
    pick('claim-committed', '2027-01-25');
    pick('claim-ack-note', 'Bắt đầu thứ Hai');
    fireEvent.submit(form);
    await waitFor(() => expect(commandsOf(h, 'acknowledgeWarrantyClaim')).toHaveLength(1));
    expect(commandsOf(h, 'acknowledgeWarrantyClaim')[0]).toMatchObject({ path: { id: claim(1).id }, body: { committed_fix_on: '2027-01-25', note: 'Bắt đầu thứ Hai' }, ifMatchVersion: 1 });
    expect(screen.queryByRole('button', { name: text('ast.claims.file.action') })).toBeNull();
  });

  it('UAT-AC391: the contractor says a claim is put right with evidence, and is told when there is none', async () => {
    const h = open({ claims: [claim(2, { status: 'ACKNOWLEDGED', committed_fix_on: '2027-01-25', allowed: { acknowledge: false, fix: true, verify: false }, version: 2 })] }, { permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.fix') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    pick('claim-fix-note', 'Đã trám và sơn lại');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.claims.problem.evidence'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    pick('claim-fixed', '2027-01-24');
    pick('claim-fix-document', EVIDENCE);
    fireEvent.submit(form);
    await waitFor(() => expect(commandsOf(h, 'recordWarrantyFix')).toHaveLength(1));
    expect(commandsOf(h, 'recordWarrantyFix')[0]).toMatchObject({ body: { fixed_on: '2027-01-24', note: 'Đã trám và sơn lại', evidence_document_version_id: EVIDENCE }, ifMatchVersion: 2 });
  });

  it('UAT-AC391: somebody else verifies the repair, saying who bears the cost, or disputes it', async () => {
    const h = open({ claims: [claim(3, { status: 'FIXED', fixed_on: '2027-01-24', allowed: { acknowledge: false, fix: false, verify: true }, version: 3 })] }, { permissions: VERIFIER });
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.verify') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect((await screen.findAllByText(text('ast.claims.problem.required'))).length).toBe(3);
    pick('claim-outcome', 'DISPUTED');
    pick('claim-bearer', 'CONTRACTOR');
    pick('claim-verify-note', 'Vết nứt vẫn còn');
    fireEvent.submit(form);
    await waitFor(() => expect(commandsOf(h, 'verifyWarrantyClaim')).toHaveLength(1));
    expect(commandsOf(h, 'verifyWarrantyClaim')[0]).toMatchObject({ body: { outcome: 'DISPUTED', cost_borne_by: 'CONTRACTOR', note: 'Vết nứt vẫn còn' }, ifMatchVersion: 3 });
  });

  it('says in words why the server refused an answer, and loads the board again', async () => {
    for (const [error, key] of [
      [problem('SELF_APPROVAL_DENIED', {}, 403), 'self'],
      [problem('CLAIM_STATE_INVALID', {}, 409), 'state'],
      [problem('VERSION_CONFLICT', {}, 409), 'conflict'],
      [problem('EVIDENCE_REQUIRED'), 'evidenceRequired'],
    ] as const) {
      const h = open({ claims: [claim(3, { status: 'FIXED', allowed: { acknowledge: false, fix: false, verify: true }, version: 3 })], command: () => error }, { permissions: VERIFIER });
      fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.verify') }));
      const form = (await dialog()).querySelector('form') as HTMLFormElement;
      pick('claim-outcome', 'VERIFIED');
      pick('claim-bearer', 'OWNER');
      pick('claim-verify-note', 'Đạt');
      const before = readsOf(h, 'listWarrantyClaims');
      fireEvent.submit(form);
      expect((await screen.findByTestId('refusal')).textContent).toBe(text(`ast.claims.error.${key}`));
      await waitFor(() => expect(readsOf(h, 'listWarrantyClaims')).toBeGreaterThan(before));
      cleanup();
    }
  });

  it('shows the actions the server allows and no others: nothing for a reader, and the file button only to one who may file', async () => {
    open({ claims: [claim(1), claim(3, { status: 'FIXED' })] }, { permissions: ['warranty.read'] });
    await screen.findByTestId('board');
    expect(document.querySelectorAll('[data-act]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: text('ast.claims.file.action') })).toBeNull();
    cleanup();
    open({ claims: [claim(1, { allowed: { acknowledge: true, fix: false, verify: false } })] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('board');
    expect(screen.queryByRole('button', { name: text('ast.claims.file.action') })).toBeNull();
    expect(document.querySelectorAll('[data-act="acknowledge"]')).toHaveLength(1);
  });

  it('says the obligations could not be loaded and loads them again, and keeps the board', async () => {
    const h = open({ claims: [claim(1)], failing: new Set(['listWarrantyObligations']) });
    expect(await screen.findByTestId('obligations-failed')).toBeTruthy();
    expect(screen.getByTestId('board')).toBeTruthy();
    const before = readsOf(h, 'listWarrantyObligations');
    fireEvent.click(screen.getByRole('button', { name: text('ast.claims.obligations.retry.action') }));
    await waitFor(() => expect(readsOf(h, 'listWarrantyObligations')).toBeGreaterThan(before));
  });

  it('offers a retry when the claims could not be read', async () => {
    const h = open({ failing: new Set(['listWarrantyClaims']) });
    fireEvent.click(await screen.findByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(readsOf(h, 'listWarrantyClaims')).toBeGreaterThanOrEqual(2));
    expect(document.querySelector('[data-testid="board"]')).toBeNull();
  });

  it('closes a dialog with the close button and with cancel, sending nothing', async () => {
    const h = open({ claims: [claim(1, { allowed: { acknowledge: true, fix: false, verify: false } })] }, { permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: text('ast.claims.act.acknowledge') }));
    await dialog();
    fireEvent.click(screen.getByRole('button', { name: text('ast.claims.dialog.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: text('ast.claims.act.acknowledge') }));
    await dialog();
    fireEvent.click(screen.getByRole('button', { name: text('ast.claims.dialog.close') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });
});
