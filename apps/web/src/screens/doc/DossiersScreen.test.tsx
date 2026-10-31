import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DossiersScreen from './DossiersScreen';
import { EMPTY_DECISION, EMPTY_HANDOVER, decisionBody, handoverBody, proposalBody, retentionIsOver, validateDecision, validateHandover, validateProposal } from './archive/rules';
import { toDossier } from './archive/types';
import { harness, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-17', 'FR-DOC-17');
const READ = ['doc.dossier.read'];
const OK = { operation_id: 'o', status: 'ARCHIVED', resource_version: 5, resource_id: 'x' };
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

const dossier = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  dossier_code: `DS-${n}`,
  year: 2026,
  title: `Hồ sơ số ${n}`,
  organization_unit: { id: '00000000-0000-4000-8000-0000000000b1', name: 'Phòng Kế hoạch' },
  category_code: 'PROJECT_INVESTMENT',
  status: 'CLOSED',
  retention: { rule_id: 'r', rule_set: 'TT74_2025_BTC', class_code: 'Y20', provisional: false, ends_on: '2046-12-31' },
  closed_at: '2026-10-29T03:00:00.000Z',
  handover_due_on: '2027-12-31',
  handed_over_at: null,
  archive_ref: null,
  disposal: null,
  item_count: 3,
  version: 3,
  actions: { addDocument: false, close: false, handover: false, proposeDisposal: false, decideDisposal: false },
  ...overrides,
});

const can = (action: 'handover' | 'proposeDisposal' | 'decideDisposal') => ({ actions: { addDocument: false, close: false, handover: false, proposeDisposal: false, decideDisposal: false, [action]: true } });

/** The server as the screen sees it: `readAll` follows the cursors of the list, so the harness answers it with the rows. */
function open(items: unknown[] | Error, command: (operation: string, input: unknown) => unknown = () => OK) {
  const h = harness(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string) => (operation === 'listDossiers' ? (items instanceof Error ? Promise.reject(items) : Promise.resolve(items)) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('DossiersScreen (DOC-17)', () => {
  it('lists the dossiers with their state, retention and archive, and offers a reader no step', async () => {
    const h = open([
      dossier(1, { status: 'OPEN', retention: { class_code: null, provisional: false, ends_on: null } }),
      dossier(2, { retention: { class_code: 'PERMANENT', provisional: true, ends_on: null } }),
      dossier(3, { status: 'ARCHIVED', archive_ref: 'KLT-2026/0001', retention: { class_code: 'Y5', provisional: false, ends_on: '2020-01-01' } }),
      dossier(4, { status: 'DISPOSAL_PROPOSED', retention: { class_code: 'Y10', provisional: false, ends_on: '2046-01-01' }, disposal_blocker: 'RETENTION_NOT_EXPIRED' }),
      dossier(5, { retention: { class_code: 'Y5', provisional: false, ends_on: '2020-01-01' }, legal_hold_active: true, disposal_blocker: 'LEGAL_HOLD_ACTIVE' }),
      dossier(6, { retention: { class_code: 'Y20', provisional: false, ends_on: '2046-12-31' }, disposal_blocker: 'RETENTION_NOT_EXPIRED' }),
    ]);
    mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
    const rows = within(await screen.findByTestId('dossiers')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.archive.dossiers.title']);
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.dossier.code'].replace('{code}', 'DS-1').replace('{year}', '2026'));
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.status.open']);
    expect(rows[1]?.querySelector('[data-testid="provisional"]')?.textContent).toBe(vi_['doc.archive.retention.provisional']);
    expect(rows[2]?.textContent).toContain(vi_['doc.archive.archive.ref'].replace('{ref}', 'KLT-2026/0001'));
    expect(rows[2]?.textContent).toContain(vi_['doc.archive.class.y5']);
    expect(rows[2]?.querySelector('[data-testid="over"]')?.textContent).toBe(vi_['doc.archive.retention.over']);
    expect(rows[3]?.textContent).toContain(vi_['doc.archive.status.disposalProposed']);
    expect(rows[3]?.textContent).toContain(vi_['doc.archive.retention.until'].replace('{date}', '2046-01-01'));
    expect(rows[3]?.querySelector('[data-testid="over"]')).toBeNull();
    // The hold indicator and what stops the disposal: shown where a disposal could be proposed, not on a dossier that is waiting for the decision.
    expect(rows[4]?.querySelector('[data-testid="hold"]')?.textContent).toBe(vi_['doc.archive.hold.active']);
    expect(rows[4]?.querySelector('[data-testid="blocker"]')?.textContent).toBe(vi_['doc.archive.problem.hold']);
    expect(rows[5]?.querySelector('[data-testid="hold"]')).toBeNull();
    expect(rows[5]?.querySelector('[data-testid="blocker"]')?.textContent).toBe(vi_['doc.archive.problem.notExpired']);
    expect(rows[3]?.querySelector('[data-testid="blocker"]')).toBeNull();
    expect(rows[0]?.querySelector('[data-testid="hold"]')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['doc.archive.handover.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['doc.archive.propose.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['doc.archive.decide.action'] })).toBeNull();
    expect(screen.getByRole('link', { name: vi_['doc.archive.policy.link'] }).getAttribute('href')).toBe('/doc/doc-18');
  });

  it('narrows the list by state', async () => {
    mountInSession(<DossiersScreen route={ROUTE} />, open([dossier(1), dossier(2, { status: 'ARCHIVED' })]), { permissions: READ });
    const user = userEvent.setup();
    await screen.findByTestId('dossiers');
    await user.selectOptions(screen.getByLabelText(vi_['doc.archive.filter.status.label']), 'ARCHIVED');
    const rows = within(screen.getByTestId('dossiers')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('ARCHIVED');
    await user.selectOptions(screen.getByLabelText(vi_['doc.archive.filter.status.label']), '');
    expect(within(screen.getByTestId('dossiers')).getAllByRole('row').slice(1)).toHaveLength(2);
  });

  it('does not read the dossiers of someone who may not, and shows nothing when there are none or the read fails', async () => {
    const denied = open([dossier(1)]);
    mountInSession(<DossiersScreen route={ROUTE} />, denied, { permissions: [] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['doc.archive.dossiers.denied']);
    expect(denied.readAll).not.toHaveBeenCalled();
    cleanup();
    const none = open([]);
    mountInSession(<DossiersScreen route={ROUTE} />, none, { permissions: READ });
    await waitFor(() => expect(none.readAll).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('dossiers')).toBeNull());
    cleanup();
    mountInSession(<DossiersScreen route={ROUTE} />, open(new Error('boom')), { permissions: READ });
    await waitFor(() => expect(screen.queryByTestId('dossiers')).toBeNull());
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('shows the standard states: loading, empty, failed, denied, offline and signed out, and reads again on retry', async () => {
    const pending = open([]);
    (pending.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mountInSession(<DossiersScreen route={ROUTE} />, pending, { permissions: READ });
    expect((await screen.findByRole('status', { name: vi_['states.loading.label'] })).getAttribute('aria-busy')).toBe('true');
    cleanup();
    mountInSession(<DossiersScreen route={ROUTE} />, open([]), { permissions: READ });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    for (const [error, title] of [
      [new Error('boom'), 'states.error.title'],
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), 'states.denied.title'],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), 'states.signedOut.title'],
    ] as const) {
      const h = open(error);
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      expect(await screen.findByText(vi_[title])).toBeTruthy();
      expect(h.readAll).toHaveBeenCalledTimes(1);
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
      cleanup();
    }
  });

  it('takes no step while the session is read-only', async () => {
    mountInSession(<DossiersScreen route={ROUTE} />, open([dossier(1, can('handover'))]), { permissions: READ, mode: 'READ_ONLY' });
    await screen.findByTestId('dossiers');
    expect(screen.queryByRole('button', { name: vi_['doc.archive.handover.action'] })).toBeNull();
  });

  describe('handing over', () => {
    it('asks for the reference and the moment before it sends, then sends them under the version it saw', async () => {
      const h = open([dossier(1, can('handover'))]);
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.handover.action'] }));
      const form = await screen.findByTestId('handover-form');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.handover.submit'] }));
      expect(within(form).getAllByText(vi_['doc.archive.field.required.error'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      await user.type(within(form).getByLabelText(vi_['doc.archive.handover.ref.label']), '  KLT-2026/0001 ');
      await user.type(within(form).getByLabelText(vi_['doc.archive.handover.at.label']), '2026-10-29T10:00');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.handover.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('handoverDossierToArchive');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: dossier(1).id }, ifMatchVersion: 3, body: { archive_ref: 'KLT-2026/0001', handed_over_at: new Date('2026-10-29T10:00').toISOString() } });
      await waitFor(() => expect(screen.queryByTestId('handover-form')).toBeNull());
    });

    it('closes the form without sending when it is cancelled, and says what the server refused', async () => {
      const h = open([dossier(1, can('handover'))], () => new ApiError({ status: 422, code: 'DOSSIER_NOT_CLOSED', correlationId: 'c' }));
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.handover.action'] }));
      await user.click(within(await screen.findByTestId('handover-form')).getByRole('button', { name: vi_['doc.archive.action.cancel'] }));
      expect(screen.queryByTestId('handover-form')).toBeNull();
      await user.click(screen.getByRole('button', { name: vi_['doc.archive.handover.action'] }));
      const form = await screen.findByTestId('handover-form');
      await user.type(within(form).getByLabelText(vi_['doc.archive.handover.ref.label']), 'KLT-2026/0001');
      await user.type(within(form).getByLabelText(vi_['doc.archive.handover.at.label']), '2026-10-29T10:00');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.handover.submit'] }));
      expect((await within(form).findByTestId('refusal')).textContent).toBe(vi_['doc.archive.problem.notClosed']);
    });
  });

  describe('proposing a disposal', () => {
    it('asks for a reason of ten characters or more, and sends it', async () => {
      const h = open([dossier(1, can('proposeDisposal'))]);
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.propose.action'] }));
      const form = await screen.findByTestId('propose-form');
      await user.type(within(form).getByLabelText(vi_['doc.archive.propose.reason.label']), 'ngắn');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.propose.submit'] }));
      expect(await within(form).findByText(vi_['doc.archive.field.tooShort.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(form).getByLabelText(vi_['doc.archive.propose.reason.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.propose.reason.label']), ' Hết thời hạn bảo quản, đề nghị xét hủy ');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.propose.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('proposeDossierDisposal');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: dossier(1).id }, ifMatchVersion: 3, body: { reason: 'Hết thời hạn bảo quản, đề nghị xét hủy' } });
    });

    it.each([
      ['RETENTION_PROVISIONAL', 422, 'doc.archive.problem.provisional'],
      ['RETENTION_NOT_EXPIRED', 422, 'doc.archive.problem.notExpired'],
      ['LEGAL_HOLD_ACTIVE', 409, 'doc.archive.problem.hold'],
      ['STAGE_TRANSITION_DENIED', 409, 'doc.archive.problem.transition'],
      ['VERSION_CONFLICT', 409, 'doc.archive.problem.conflict'],
      ['VALIDATION_FAILED', 422, 'doc.archive.problem.invalid'],
      ['SCOPE_DENIED', 403, 'doc.archive.problem.scope'],
      ['RESOURCE_NOT_FOUND', 404, 'doc.archive.problem.notFound'],
      ['OTHER', 500, 'doc.archive.problem.general'],
    ] as const)('says in words what the server refused: %s', async (code, status, key) => {
      const h = open([dossier(1, can('proposeDisposal'))], () => new ApiError({ status, code, correlationId: 'c' }));
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.propose.action'] }));
      const form = await screen.findByTestId('propose-form');
      await user.type(within(form).getByLabelText(vi_['doc.archive.propose.reason.label']), 'Hết thời hạn bảo quản, đề nghị xét hủy');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.propose.submit'] }));
      expect((await within(form).findByTestId('refusal')).textContent).toBe(vi_[key]);
    });
  });

  describe('deciding a disposal', () => {
    const proposed = (overrides: Record<string, unknown> = {}) =>
      dossier(1, {
        status: 'DISPOSAL_PROPOSED',
        disposal: { proposed_by: 'm1', proposed_at: '2031-10-30T03:00:00.000Z', reason: 'Hết thời hạn bảo quản', from_status: 'ARCHIVED', decided_by: null, decided_at: null, council_decision_document_id: null, comment: null },
        ...can('decideDisposal'),
        ...overrides,
      });

    it('shows the proposal, asks an approval for the document of the council, and sends the decision', async () => {
      const h = open([proposed()]);
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.decide.action'] }));
      const form = await screen.findByTestId('decide-form');
      expect(within(form).getByTestId('proposal-reason').textContent).toBe(vi_['doc.archive.decide.proposal'].replace('{reason}', 'Hết thời hạn bảo quản'));
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.decide.submit'] }));
      expect(await within(form).findByText(vi_['doc.archive.field.required.error'])).toBeTruthy();
      await user.type(within(form).getByLabelText(vi_['doc.archive.decide.document.label']), 'not-a-uuid');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.decide.submit'] }));
      expect(await within(form).findByText(vi_['doc.archive.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(form).getByLabelText(vi_['doc.archive.decide.document.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.decide.document.label']), DOCUMENT.toUpperCase());
      await user.type(within(form).getByLabelText(vi_['doc.archive.decide.comment.label']), ' Đồng ý theo biên bản số 12 ');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.decide.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('decideDossierDisposal');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: dossier(1).id }, ifMatchVersion: 3, body: { decision: 'APPROVE', council_decision_document_id: DOCUMENT, comment: 'Đồng ý theo biên bản số 12' } });
    });

    it('sends a rejection without a document, even when one was typed before the decision was switched', async () => {
      const h = open([proposed()]);
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.decide.action'] }));
      const form = await screen.findByTestId('decide-form');
      await user.type(within(form).getByLabelText(vi_['doc.archive.decide.document.label']), 'half-typed');
      await user.click(within(form).getByLabelText(vi_['doc.archive.decide.reject']));
      expect(within(form).queryByLabelText(vi_['doc.archive.decide.document.label'])).toBeNull();
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.decide.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'REJECT' } });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('council_decision_document_id');
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'doc.archive.problem.selfApproval'],
      ['DECISION_DOCUMENT_REQUIRED', 422, 'doc.archive.problem.decisionDocument'],
      ['LEGAL_HOLD_ACTIVE', 409, 'doc.archive.problem.hold'],
    ] as const)('says in words what the server refused: %s', async (code, status, key) => {
      const h = open([proposed()], () => new ApiError({ status, code, correlationId: 'c' }));
      mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.decide.action'] }));
      const form = await screen.findByTestId('decide-form');
      await user.type(within(form).getByLabelText(vi_['doc.archive.decide.document.label']), DOCUMENT);
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.decide.submit'] }));
      expect((await within(form).findByTestId('refusal')).textContent).toBe(vi_[key]);
    });

    it('starts the form over when the tenant changes', async () => {
      const h = open([dossier(1, can('handover'))]);
      const view = mountInSession(<DossiersScreen route={ROUTE} />, h, { permissions: READ });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.handover.action'] }));
      expect(await screen.findByTestId('handover-form')).toBeTruthy();
      view.rerenderWith({ permissions: READ, tenant: { ...(await import('./test-support')).SECOND_TENANT } });
      await waitFor(() => expect(screen.queryByTestId('handover-form')).toBeNull());
    });
  });
});

describe('the rules of the archive forms', () => {
  it('judges a handover: the reference of three to two hundred characters and a moment', () => {
    expect(validateHandover(EMPTY_HANDOVER)).toEqual({ archiveRef: 'required', handedOverAt: 'required' });
    expect(validateHandover({ archiveRef: 'ab', handedOverAt: 'nonsense' })).toEqual({ archiveRef: 'tooShort', handedOverAt: 'invalid' });
    expect(validateHandover({ archiveRef: 'x'.repeat(201), handedOverAt: '2026-10-29T10:00' }).archiveRef).toBe('tooLong');
    expect(validateHandover({ archiveRef: 'abc', handedOverAt: '2026-10-29T10:00' })).toEqual({ archiveRef: undefined, handedOverAt: undefined });
    expect(handoverBody({ archiveRef: ' abc ', handedOverAt: '2026-10-29T10:00' })).toEqual({ archive_ref: 'abc', handed_over_at: new Date('2026-10-29T10:00').toISOString() });
  });

  it('judges a proposal and a decision', () => {
    expect(validateProposal('').reason).toBe('required');
    expect(validateProposal('x'.repeat(9)).reason).toBe('tooShort');
    expect(validateProposal('x'.repeat(2001)).reason).toBe('tooLong');
    expect(validateProposal('x'.repeat(10)).reason).toBeUndefined();
    expect(proposalBody('  lý do  ')).toEqual({ reason: 'lý do' });
    expect(validateDecision(EMPTY_DECISION).councilDecisionDocumentId).toBe('required');
    expect(validateDecision({ ...EMPTY_DECISION, councilDecisionDocumentId: DOCUMENT }).councilDecisionDocumentId).toBeUndefined();
    expect(validateDecision({ decision: 'REJECT', councilDecisionDocumentId: '', comment: '' }).councilDecisionDocumentId).toBeUndefined();
    // What is left in the hidden field after a switch to a rejection is not judged.
    expect(validateDecision({ decision: 'REJECT', councilDecisionDocumentId: DOCUMENT, comment: '' }).councilDecisionDocumentId).toBeUndefined();
    expect(validateDecision({ decision: 'REJECT', councilDecisionDocumentId: 'bad', comment: '' }).councilDecisionDocumentId).toBeUndefined();
    expect(validateDecision({ ...EMPTY_DECISION, councilDecisionDocumentId: 'bad' }).councilDecisionDocumentId).toBe('invalid');
    expect(validateDecision({ ...EMPTY_DECISION, councilDecisionDocumentId: DOCUMENT, comment: 'x'.repeat(1001) }).comment).toBe('tooLong');
    expect(decisionBody({ decision: 'APPROVE', councilDecisionDocumentId: ` ${DOCUMENT.toUpperCase()} `, comment: '  ' })).toEqual({ decision: 'APPROVE', council_decision_document_id: DOCUMENT });
    expect(decisionBody({ decision: 'REJECT', councilDecisionDocumentId: DOCUMENT, comment: ' ý kiến ' })).toEqual({ decision: 'REJECT', comment: 'ý kiến' });
  });

  it('reads a dossier as the server gives it, with defaults for what is missing, and tells a retention that is over', () => {
    const read = toDossier(dossier(1, { status: 'DISPOSAL_PROPOSED', disposal: { proposed_by: 'm1', proposed_at: 't', reason: 'r', from_status: 'ARCHIVED' }, retention: { class_code: 'Y5', provisional: false, ends_on: '2020-01-01' } }));
    expect(read).toMatchObject({ status: 'DISPOSAL_PROPOSED', retentionClass: 'Y5', retentionEndsOn: '2020-01-01', disposal: { proposedBy: 'm1', fromStatus: 'ARCHIVED', decidedBy: null, councilDecisionDocumentId: null } });
    expect(toDossier({ legal_hold_active: true, disposal_blocker: 'NOPE' })).toMatchObject({ holdActive: true, disposalBlocker: null });
    expect(toDossier({ disposal_blocker: 'RETENTION_PROVISIONAL' })).toMatchObject({ holdActive: false, disposalBlocker: 'RETENTION_PROVISIONAL' });
    expect(toDossier(undefined)).toMatchObject({ id: '', status: 'OPEN', retentionClass: null, disposal: null, itemCount: 0, mayHandover: false });
    expect(toDossier({ disposal: 'x', retention: 3, actions: 4, organization_unit: 5 })).toMatchObject({ disposal: null, retentionClass: null, mayDecideDisposal: false, unitName: '' });
    expect(retentionIsOver({ retentionEndsOn: '2020-01-01', provisional: false }, '2026-10-29')).toBe(true);
    expect(retentionIsOver({ retentionEndsOn: '2026-10-29', provisional: false }, '2026-10-29')).toBe(true);
    expect(retentionIsOver({ retentionEndsOn: '2026-10-30', provisional: false }, '2026-10-29')).toBe(false);
    expect(retentionIsOver({ retentionEndsOn: null, provisional: false }, '2026-10-29')).toBe(false);
    expect(retentionIsOver({ retentionEndsOn: '2020-01-01', provisional: true }, '2026-10-29')).toBe(false);
  });
});
