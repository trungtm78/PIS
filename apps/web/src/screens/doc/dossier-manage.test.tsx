import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import DossiersScreen from './DossiersScreen';
import { vietnamToday } from './archive/DossierManage';
import IncomingHandlingScreen from './incoming/IncomingHandlingScreen';
import { harness, mountInSession, routeOf } from './test-support';

afterEach(cleanup);

const UNIT = '00000000-0000-4000-8000-0000000000b1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const MANAGE = ['doc.dossier.read', 'doc.dossier.manage'];
const OK = { operation_id: 'o', status: 'OPEN', resource_version: 2, resource_id: 'x' };
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const dossier = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  dossier_code: `DS-${n}`,
  year: 2026,
  title: `Dossier ${n}`,
  organization_unit: { id: UNIT, name: 'Planning' },
  category_code: 'PROJECT_INVESTMENT',
  status: 'OPEN',
  retention: { rule_id: null, rule_set: null, class_code: null, provisional: false, ends_on: null },
  closed_at: null,
  handover_due_on: null,
  handed_over_at: null,
  archive_ref: null,
  disposal: null,
  item_count: 2,
  version: 4,
  actions: { addDocument: true, close: true, handover: false, proposeDisposal: false, decideDisposal: false },
  ...overrides,
});
const rule = (overrides: Record<string, unknown> = {}) => ({ id: 'r1', rule_set: 'TT74_2025_BTC', category_code: 'PROJECT_INVESTMENT', class_code: 'Y20', retention_years: 20, start_basis: 'FROM_CLOSED', handover_months: 12, legal_basis: 'Circular 74', confirmation_status: 'CONFIRMED', precedence: 10, effective_from: '2026-01-01', effective_until: null, status: 'PUBLISHED', version: 1, ...overrides });

interface Server {
  dossiers?: unknown[];
  rules?: unknown[] | Error;
  units?: unknown[] | Error;
  detail?: unknown;
}
function server(config: Server, command: (operation: string, input: unknown) => unknown = () => OK) {
  const rows: Record<string, unknown> = { listDossiers: config.dossiers ?? [dossier(1)], listDocumentRetentionRules: config.rules ?? [rule()], get_resources_organization_unit: config.units ?? [{ id: UNIT, code: 'PLN', name: 'Planning' }] };
  const h = harness((operation) => (operation === 'getDossier' ? (config.detail ?? { ...dossier(1), items: [{ id: 'i1', document_id: DOCUMENT, ordinal: 1, title: 'Decision 12', doc_kind: 'OUTGOING', doc_type_code: 'QD', classification: 'INTERNAL', issued_on: '2026-10-01' }] }) : new Error(`unexpected read ${operation}`)), command);
  const readAll = vi.fn((operation: string) => {
    const answer = rows[operation];
    return answer instanceof Error ? Promise.reject(answer) : Array.isArray(answer) ? Promise.resolve(answer) : Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  return Object.assign(h, { readAll });
}
const mountScreen = (h: ReturnType<typeof server>, permissions: readonly string[] = MANAGE) => mountInSession(<DossiersScreen route={routeOf('DOC-17', 'FR-DOC-17')} />, h, { permissions });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the day of Vietnam, not of the browser', () => {
  it('is the next calendar day from 17:00 UTC, as the server counts it', () => {
    expect(vietnamToday(Date.UTC(2026, 10, 8, 16, 59))).toBe('2026-11-08');
    expect(vietnamToday(Date.UTC(2026, 10, 8, 17, 30))).toBe('2026-11-09');
    expect(vietnamToday(Date.UTC(2026, 10, 8, 23, 59))).toBe('2026-11-09');
  });

  it('accepts a settlement day of tomorrow in the browser clock when it is already today in Vietnam, and the preview uses that day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 8, 18, 0) });
    try {
      const h = server({ rules: [rule({ effective_from: '2026-11-09' })] });
      mountScreen(h);
      fireEvent.click(await screen.findByTestId('open-00000000-0000-4000-8000-0000000000a1'));
      const form = await screen.findByTestId('close-dossier-form');
      await waitFor(() => expect(within(form).getByTestId('close-rule').textContent).toContain('Circular 74'));
      fireEvent.change(within(form).getByLabelText(tr('doc.dossier.close.settlement')), { target: { value: '2026-11-09' } });
      fireEvent.submit(form);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('closeDossier', expect.objectContaining({ body: { settlement_closed_on: '2026-11-09' } })));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('creating a dossier (createDossier)', () => {
  it('offers the action only to a person who may manage dossiers, and not to a frozen session', async () => {
    mountScreen(server({}), ['doc.dossier.read']);
    await screen.findByTestId('dossiers');
    expect(screen.queryByTestId('new-dossier')).toBeNull();
    cleanup();
    mountInSession(<DossiersScreen route={routeOf('DOC-17', 'FR-DOC-17')} />, server({}), { permissions: MANAGE, mode: 'READ_ONLY' });
    await screen.findByTestId('dossiers');
    expect(screen.queryByTestId('new-dossier')).toBeNull();
  });

  it('checks the form first, then sends the dossier once with the unit and the category the person chose', async () => {
    const h = server({});
    mountScreen(h);
    fireEvent.click(await screen.findByTestId('new-dossier'));
    await screen.findByRole('option', { name: 'PLN · Planning' });
    fireEvent.submit(screen.getByTestId('create-dossier-form'));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(1);
    type(tr('doc.dossier.create.code'), 'DS-2026-77');
    type(tr('doc.dossier.create.name'), 'Dossier of the bridge');
    type(tr('doc.dossier.create.unit'), UNIT);
    await screen.findByRole('option', { name: 'PROJECT_INVESTMENT' });
    type(tr('doc.dossier.create.category'), 'PROJECT_INVESTMENT');
    fireEvent.submit(screen.getByTestId('create-dossier-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('createDossier', expect.objectContaining({ body: { dossier_code: 'DS-2026-77', year: new Date().getFullYear(), title: 'Dossier of the bridge', organization_unit_id: UNIT, category_code: 'PROJECT_INVESTMENT' } }));
    await waitFor(() => expect(screen.queryByTestId('create-dossier-form')).toBeNull());
  });

  it('says a number used twice in words and keeps the form; falls back to typing the unit when the units cannot be read', async () => {
    const h = server({ units: problem(403, 'SCOPE_DENIED'), rules: problem(500, 'BOOM') }, () => problem(409, 'DOSSIER_CODE_DUPLICATE'));
    mountScreen(h);
    fireEvent.click(await screen.findByTestId('new-dossier'));
    expect(await screen.findByTestId('unit-typed')).toBeTruthy();
    type(tr('doc.dossier.create.code'), 'DS-2026-77');
    type(tr('doc.dossier.create.name'), 'Dossier of the bridge');
    type(tr('doc.dossier.create.unit'), UNIT);
    type(tr('doc.dossier.create.category'), 'project_investment');
    fireEvent.submit(screen.getByTestId('create-dossier-form'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(tr('doc.archive.problem.duplicateCode'));
    expect((screen.getByLabelText(tr('doc.dossier.create.code')) as HTMLInputElement).value).toBe('DS-2026-77');
  });
});

describe('one dossier in full (getDossier), adding a document (addDocumentToDossier) and closing (closeDossier)', () => {
  const openDetail = async (h: ReturnType<typeof server>) => {
    mountScreen(h);
    fireEvent.click(await screen.findByTestId('open-00000000-0000-4000-8000-0000000000a1'));
    return screen.findByTestId('dossier-detail');
  };

  it('shows the contents, the retention that is not fixed while the dossier is open, and the "i" of the retention', async () => {
    const panel = await openDetail(server({}));
    expect(await within(panel).findByTestId('dossier-items')).toBeTruthy();
    expect(within(panel).getByText('Decision 12')).toBeTruthy();
    expect(within(panel).getByTestId('detail-retention').textContent).toContain(tr('doc.dossier.detail.retention.open'));
    expect(within(panel).getAllByRole('button').some((button) => button.className.includes('ui-info'))).toBe(true);
  });

  it('says the dossier is empty, and shows an error with a retry', async () => {
    const h = server({ detail: { ...dossier(1), item_count: 0, items: [] } });
    const panel = await openDetail(h);
    expect(await within(panel).findByTestId('detail-empty')).toBeTruthy();
    cleanup();
    let calls = 0;
    const failing = server({});
    const read = failing.read;
    read.mockImplementation((operation: string) => (operation === 'getDossier' ? (calls++ === 0 ? Promise.reject(problem(500, 'BOOM')) : Promise.resolve({ ...dossier(1), items: [] })) : Promise.reject(new Error(operation))));
    const errored = await openDetail(failing);
    fireEvent.click(within(await within(errored).findByTestId('detail-error')).getByRole('button'));
    expect(await within(errored).findByTestId('detail-empty')).toBeTruthy();
  });

  it('puts a document into an open dossier under the version of the dossier, after checking the identifier', async () => {
    const h = server({});
    const panel = await openDetail(h);
    const form = await within(panel).findByTestId('add-document-form');
    fireEvent.submit(form);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(tr('doc.dossier.item.document')), { target: { value: DOCUMENT } });
    fireEvent.change(within(form).getByLabelText(tr('doc.dossier.item.ordinal')), { target: { value: '2' } });
    fireEvent.submit(form);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('addDocumentToDossier', expect.objectContaining({ path: { id: '00000000-0000-4000-8000-0000000000a1' }, ifMatchVersion: 4, body: { document_id: DOCUMENT, ordinal: 2 } })));
  });

  it('says a document that is already filed or not fileable in words', async () => {
    const h = server({}, () => problem(409, 'DOCUMENT_ALREADY_IN_DOSSIER'));
    const panel = await openDetail(h);
    const form = await within(panel).findByTestId('add-document-form');
    fireEvent.change(within(form).getByLabelText(tr('doc.dossier.item.document')), { target: { value: DOCUMENT } });
    fireEvent.submit(form);
    expect((await within(form).findByTestId('refusal')).textContent).toBe(tr('doc.archive.problem.alreadyIn'));
  });

  it('shows the retention rule that will apply before closing, closes with the settlement day, and offers neither step to a dossier the server does not allow', async () => {
    const h = server({});
    const panel = await openDetail(h);
    const form = await within(panel).findByTestId('close-dossier-form');
    await waitFor(() => expect(within(form).getByTestId('close-rule').textContent).toContain('Circular 74'));
    fireEvent.change(within(form).getByLabelText(tr('doc.dossier.close.settlement')), { target: { value: '2026-10-01' } });
    fireEvent.submit(form);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('closeDossier', expect.objectContaining({ ifMatchVersion: 4, body: { settlement_closed_on: '2026-10-01' } })));
    cleanup();
    const none = { addDocument: false, close: false, handover: false, proposeDisposal: false, decideDisposal: false };
    const closed = server({ dossiers: [dossier(1, { actions: none })], detail: { ...dossier(1, { actions: none }), items: [] } });
    const view = await openDetail(closed);
    await within(view).findByTestId('detail-empty');
    expect(within(view).queryByTestId('add-document-form')).toBeNull();
    expect(within(view).queryByTestId('close-dossier-form')).toBeNull();
  });

  it('says that an unconfirmed rule makes the retention provisional, and an empty dossier cannot be closed', async () => {
    const h = server({ rules: [rule({ confirmation_status: 'PENDING_CONFIRMATION' })] }, () => problem(422, 'DOSSIER_EMPTY'));
    const panel = await openDetail(h);
    const form = await within(panel).findByTestId('close-dossier-form');
    await waitFor(() => expect(within(form).getByTestId('close-rule').textContent).toBe(tr('doc.dossier.close.rule.unconfirmed', { class: tr('doc.archive.class.y20') })));
    fireEvent.submit(form);
    expect((await within(form).findByTestId('refusal')).textContent).toBe(tr('doc.archive.problem.empty'));
  });
});

describe('filing a resolved incoming letter into a dossier (fileIncomingDocument)', () => {
  const LETTER = '00000000-0000-4000-8000-0000000000c1';
  const letter = (status: string) => ({
    id: LETTER,
    document_id: '00000000-0000-4000-8000-0000000e0001',
    status,
    channel: 'UPLOAD',
    title: 'Letter 15',
    doc_type_code: 'CV',
    classification: 'INTERNAL',
    received_at: '2026-10-21T02:00:00.000Z',
    register: { id: '00000000-0000-4000-8000-000000000a01', code: 'REG-DEN-2026' },
    number: 10,
    symbol: '10/REG-DEN-2026',
    original_symbol: '1/BTC',
    original_issued_on: '2026-10-20',
    sender_name: 'Ministry',
    urgency: 'NORMAL',
    due_on: '2026-10-27',
    leader_directive: null,
    assigned_unit: { id: UNIT, name: 'Planning' },
    assignee: { user_id: '00000000-0000-4000-8000-0000000000b1', display_name: 'An' },
    resolution_summary: null,
    resolved_at: null,
    late_days: null,
    response_outgoing_id: null,
    duplicate_of_id: null,
    duplicate_override_reason: null,
    rejection_reason: null,
    is_overdue: false,
    overdue_since: null,
    overdue_days: null,
    file_sha256: 'a'.repeat(64),
    version: 7,
    updated_at: '2026-10-23T03:00:00.000Z',
    actions: { register: false, reject: false, assign: false, startProcessing: false, resolve: false },
  });
  const openLetter = (status: string, dossiers: unknown[], command: (operation: string, input: unknown) => unknown = () => OK, permissions: readonly string[] = ['doc.dossier.manage', 'doc.dossier.read']) => {
    const h = server({ dossiers }, command);
    h.read.mockImplementation((operation: string) => (operation === 'getIncomingDocument' ? Promise.resolve(letter(status)) : Promise.reject(new Error(operation))));
    mountInSession(<IncomingHandlingScreen route={routeOf('DOC-13', 'FR-DOC-13')} />, h, { permissions }, `/doc/doc-13?id=${LETTER}`);
    return h;
  };

  it('offers the action on a resolved letter only, and to a person who may manage dossiers', async () => {
    openLetter('PROCESSING', []);
    await screen.findByTestId('letter-status');
    expect(document.querySelector('[data-action="file"]')).toBeNull();
    cleanup();
    openLetter('RESOLVED', [], undefined, ['doc.incoming.read']);
    await screen.findByTestId('letter-status');
    expect(document.querySelector('[data-action="file"]')).toBeNull();
  });

  it('offers only the open dossiers the person may add to, and files under the version of the letter', async () => {
    const h = openLetter('RESOLVED', [dossier(1), dossier(2, { status: 'CLOSED' }), dossier(3, { actions: { addDocument: false } })], () => ({ operation_id: 'o', status: 'FILED', resource_version: 8, resource_id: LETTER }));
    await screen.findByTestId('letter-status');
    fireEvent.click(document.querySelector('[data-action="file"]') as HTMLElement);
    const select = (await screen.findByLabelText(tr('doc.dossier.file.dossier'))) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', '00000000-0000-4000-8000-0000000000a1']);
    fireEvent.click(screen.getByRole('button', { name: tr('doc.dossier.file.submit') }));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: '00000000-0000-4000-8000-0000000000a1' } });
    fireEvent.click(screen.getByRole('button', { name: tr('doc.dossier.file.submit') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('fileIncomingDocument', expect.objectContaining({ path: { id: LETTER }, ifMatchVersion: 7, body: { dossier_id: '00000000-0000-4000-8000-0000000000a1' } })));
  });

  it('says there is no open dossier to file into, and says a closed dossier in words', async () => {
    openLetter('RESOLVED', [dossier(2, { status: 'CLOSED' })]);
    await screen.findByTestId('letter-status');
    fireEvent.click(document.querySelector('[data-action="file"]') as HTMLElement);
    expect(await screen.findByTestId('file-no-dossier')).toBeTruthy();
    cleanup();
    openLetter('RESOLVED', [dossier(1)], () => problem(409, 'DOSSIER_NOT_OPEN'));
    await screen.findByTestId('letter-status');
    fireEvent.click(document.querySelector('[data-action="file"]') as HTMLElement);
    fireEvent.change(await screen.findByLabelText(tr('doc.dossier.file.dossier')), { target: { value: '00000000-0000-4000-8000-0000000000a1' } });
    fireEvent.click(screen.getByRole('button', { name: tr('doc.dossier.file.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(tr('doc.archive.problem.notOpen'));
  });
});
