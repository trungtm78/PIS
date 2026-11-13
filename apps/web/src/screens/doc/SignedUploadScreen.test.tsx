import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import SignedUploadScreen from './SignedUploadScreen';
import { SECOND_TENANT, harness, mountInSession, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('DOC-09', 'FR-DOC-09');
const UPLOAD = 'doc.file.upload';
const ATTACH = 'doc.outgoing.upload_signed';
const EXTERNAL = 'doc.outgoing.register_external';
const READ = 'doc.outgoing.read';
const ALL = [UPLOAD, ATTACH, EXTERNAL, READ];
const WAITING = '00000000-0000-4000-8000-000000000301';
const OTHER = '00000000-0000-4000-8000-000000000302';
const UNIT = '00000000-0000-4000-8000-000000000f01';
const REGISTER = '00000000-0000-4000-8000-000000000a01';
const SHA = 'c'.repeat(64);

const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const signature = (overrides: Record<string, unknown> = {}) => ({
  role: 'LEADER',
  status: 'VALID',
  chain_status: 'TRUSTED',
  signed_at: '2026-10-22T03:00:00.000Z',
  timestamp_proven: true,
  incremental_changes_allowed: true,
  findings: [],
  ...overrides,
});

const uploaded = (overrides: Record<string, unknown> = {}) => ({
  file_object_key: 'tenants/t/document/file-1',
  file_sha256: SHA,
  size_bytes: 4096,
  page_count: 2,
  overall: 'VALID',
  signatures: [signature()],
  ...overrides,
});

const waiting = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  document_id: `d-${id}`,
  title: `Decision ${id.slice(-3)}`,
  doc_type_code: 'QD',
  status: 'SUBMITTED',
  effect_status: 'PENDING',
  urgency: 'NORMAL',
  circulation: 'INTERNAL_CIRCULATION',
  drafting_unit_id: UNIT,
  drafter_user_id: '00000000-0000-4000-8000-0000000000a1',
  signer_user_id: '00000000-0000-4000-8000-0000000000b2',
  signer_title: 'CHAIRMAN',
  signing_mode: 'DIRECT',
  payload: {},
  recipients: [],
  version: 4,
  created_at: '2026-10-23T03:00:00.000Z',
  ...overrides,
});

const registerRow = (overrides: Record<string, unknown> = {}) => ({
  id: REGISTER,
  register_code: 'OUT-2026',
  name: 'Outgoing 2026',
  direction: 'OUTGOING',
  organization_unit_id: UNIT,
  year: 2026,
  mode: 'MANAGED',
  last_number: 127,
  next_number: 128,
  status: 'OPEN',
  scope_doc_types: ['QD'],
  version: 1,
  ...overrides,
});

interface Options {
  queue?: unknown;
  registers?: unknown[];
  upload?: unknown;
  commands?: Record<string, unknown>;
}

function world(options: Options = {}): { h: Harness; upload: ReturnType<typeof vi.fn> } {
  const read = (operation: string): unknown => {
    if (operation === 'listOutgoingDocuments') return options.queue ?? { items: [waiting(WAITING), waiting(OTHER, { version: 7 })], next_cursor: null };
    if (operation === 'listDocumentNumberRegisters') {
      return { items: options.registers ?? [registerRow()], doc_types: [{ id: 't1', code: 'QD', name: 'Decision', symbol_kind: 'DECISION', symbol_pattern: '{number}/QD', register_code: 'OUT', status: 'ACTIVE', version: 1 }], next_cursor: null };
    }
    return new Error(`unexpected read ${operation}`);
  };
  const command = (operation: string): unknown => options.commands?.[operation] ?? { operation_id: 'o', status: 'SIGNED', resource_version: 5, resource_id: WAITING };
  const h = harness(read, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(async () => [{ id: UNIT, code: 'DEPT-2', name: 'Department of Planning' }]);
  const upload = vi.fn(() => (options.upload instanceof Error ? Promise.reject(options.upload) : Promise.resolve(options.upload ?? uploaded())));
  (h.client as unknown as { upload: unknown }).upload = upload;
  return { h, upload: upload as unknown as ReturnType<typeof vi.fn> };
}

const pdf = (name = 'decision.pdf'): File => new File(['%PDF-1.7 signed'], name, { type: 'application/pdf' });
const open = (h: Harness, permissions: readonly string[] | undefined = ALL, mode?: 'READ_ONLY') => mountInSession(<SignedUploadScreen route={ROUTE} />, h, { permissions, ...(mode === undefined ? {} : { mode }) });
const fileInput = () => screen.getByLabelText(vi_['doc.signed.file.label']) as HTMLInputElement;
const readButton = () => screen.getByRole('button', { name: vi_['doc.signed.file.read.action'] }) as HTMLButtonElement;
const attachButton = () => screen.getByRole('button', { name: vi_['doc.signed.leader.attach.action'] }) as HTMLButtonElement;
const registerButton = () => screen.getByRole('button', { name: vi_['doc.signed.external.register.action'] }) as HTMLButtonElement;
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

async function readFile(user: ReturnType<typeof userEvent.setup>, file: File = pdf()): Promise<void> {
  await user.upload(fileInput(), file);
  await user.click(readButton());
  await screen.findByTestId('verdict');
}

const waitingReady = () => waitFor(() => expect(screen.getByRole('option', { name: new RegExp(`Decision ${WAITING.slice(-3)}`) })).toBeTruthy());

afterEach(cleanup);

describe('SignedUploadScreen (DOC-09): the leader signed with their own tool (AC-ST-DOC-009-2)', () => {
  it('uploads the file, shows what its signatures hold, and attaches it to the document that waits under the version it read', async () => {
    const { h, upload } = world();
    open(h);
    await waitingReady();
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.signed.page.title']);
    expect(readButton().matches(':disabled')).toBe(true);
    await readFile(user);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe('uploadDocumentFile');
    const verdict = screen.getByTestId('verdict');
    expect(verdict.getAttribute('data-overall')).toBe('VALID');
    expect(within(verdict).getByText(SHA)).toBeTruthy();
    expect(within(verdict).getByText(vi_['doc.signed.result.sizeValue'].replace('{kb}', '4'))).toBeTruthy();
    const row = within(verdict).getByText(vi_['doc.signed.role.leader']).closest('tr');
    expect(row?.textContent).toContain(vi_['doc.signed.chain.trusted']);
    expect(row?.textContent).toContain('2026-10-22 03:00');
    expect(row?.textContent).toContain(vi_['doc.signed.time.proven']);
    expect(attachButton().matches(':disabled')).toBe(true);
    await user.selectOptions(screen.getByLabelText(vi_['doc.signed.leader.document.label']), OTHER);
    expect(attachButton().matches(':disabled')).toBe(false);
    await user.click(attachButton());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('uploadLeaderSignedDocument', expect.objectContaining({ path: { id: OTHER }, body: { file_object_key: 'tenants/t/document/file-1', file_sha256: SHA }, ifMatchVersion: 7 }));
    expect((await screen.findByText(new RegExp(vi_['doc.signed.done.leader'].slice(0, 20)))).closest('p')?.getAttribute('data-done')).toBe('LEADER');
    expect(screen.getByRole('link', { name: vi_['doc.signed.done.leader.next'] }).getAttribute('href')).toBe(`/doc/doc-06?doc=${WAITING}`);
  });

  it('shows a signature whose time nobody proved with its finding, and does not offer to attach it', async () => {
    const { h } = world({ upload: uploaded({ overall: 'INDETERMINATE', signatures: [signature({ timestamp_proven: false, findings: ['SIGNING_TIME_UNPROVEN'], status: 'INDETERMINATE' })] }) });
    open(h);
    await waitingReady();
    const user = userEvent.setup();
    await readFile(user);
    const verdict = screen.getByTestId('verdict');
    expect(within(verdict).getByText(vi_['doc.signed.finding.timeUnproven'])).toBeTruthy();
    expect(within(verdict).getByText(vi_['doc.signed.time.unproven'])).toBeTruthy();
    expect(verdict.querySelector('[data-blocked="true"]')?.textContent).toBe(vi_['doc.signed.result.blocked']);
    await user.selectOptions(screen.getByLabelText(vi_['doc.signed.leader.document.label']), WAITING);
    expect(attachButton().matches(':disabled')).toBe(true);
  });

  it('says that an unsigned PDF carries no signature, and a changed one is not valid', async () => {
    const { h } = world({ upload: uploaded({ signatures: [], overall: 'VALID' }) });
    open(h);
    await waitingReady();
    const user = userEvent.setup();
    await readFile(user);
    expect(screen.getByTestId('verdict').querySelector('[data-unsigned="true"]')?.textContent).toBe(vi_['doc.signed.result.none']);
    expect(screen.getByTestId('verdict').querySelector('[data-blocked="true"]')).toBeTruthy();
    cleanup();
    const changed = world({ upload: uploaded({ overall: 'INVALID', signatures: [signature({ status: 'INVALID', chain_status: 'UNTRUSTED' })] }) });
    open(changed.h);
    await waitingReady();
    await readFile(userEvent.setup());
    expect(screen.getByTestId('verdict').getAttribute('data-overall')).toBe('INVALID');
    // The verdict, the row of the signature and the declared result of the verification.
    expect(screen.getAllByText(vi_['doc.signed.overall.invalid']).length).toBe(3);
    expect(screen.getByTestId('declared-verdict').textContent).toBe(vi_['doc.signed.overall.invalid']);
    expect(screen.getByText(vi_['doc.signed.chain.untrusted'])).toBeTruthy();
  });

  it('turns back a file that is not a PDF, an empty one and a large one before sending them', async () => {
    const { h, upload } = world();
    open(h);
    await waitingReady();
    const user = userEvent.setup();
    const send = async (file: File | undefined): Promise<void> => {
      fireEvent.change(fileInput(), { target: { files: file === undefined ? [] : [file] } });
      if (readButton().disabled) return;
      await user.click(readButton());
    };
    await send(new File(['text'], 'notes.txt', { type: 'text/plain' }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.signed.file.notPdf']);
    await send(new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.signed.file.empty']);
    await send(new File([new Uint8Array(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.signed.file.tooLarge']);
    expect(upload).not.toHaveBeenCalled();
    await send(undefined);
    expect(readButton().matches(':disabled')).toBe(true);
  });

  it('shows why the server refused the file, with what it found in it', async () => {
    const { h } = world({ upload: problem('UPLOAD_NOT_PDF') });
    open(h);
    await waitingReady();
    const user = userEvent.setup();
    await user.upload(fileInput(), pdf());
    await user.click(readButton());
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.signed.problem.notPdf']);
    expect(screen.queryByTestId('verdict')).toBeNull();
  });

  it('tells a refused attachment: the signature, the identity of the signer, a document that moved on, a drafter who may not upload', async () => {
    const cases: Array<[ApiError, string]> = [
      [problem('SIGNING_TIME_UNPROVEN', 422, { findings: ['SIGNING_TIME_UNPROVEN'] }), vi_['doc.signed.problem.timeUnproven']],
      [problem('SIGNER_NOT_AUTHORIZED', 422, { reason: 'SIGNER_IDENTITY_MISMATCH' }), vi_['doc.signed.problem.signerMismatch']],
      [problem('SIGNER_NOT_AUTHORIZED'), vi_['doc.signed.problem.notAuthorised']],
      [problem('SIGNED_CONTENT_MISMATCH'), vi_['doc.signed.problem.contentMismatch']],
      [problem('VERSION_CONFLICT', 409), vi_['doc.signed.problem.conflict']],
      [problem('SELF_APPROVAL_DENIED', 403), vi_['doc.signed.problem.selfUpload']],
    ];
    for (const [error, message] of cases) {
      const { h } = world({ commands: { uploadLeaderSignedDocument: error } });
      open(h);
      await waitingReady();
      const user = userEvent.setup();
      await readFile(user);
      await user.selectOptions(screen.getByLabelText(vi_['doc.signed.leader.document.label']), WAITING);
      await user.click(attachButton());
      const alert = await screen.findByText(message);
      expect(alert.closest('[role="alert"]')?.getAttribute('data-problem')).toBeTruthy();
      cleanup();
    }
  });

  it('lists a failure to read the queue and an empty queue next to the choice', async () => {
    const failing = world({ queue: problem('SCOPE_DENIED', 403) });
    open(failing.h);
    expect((await screen.findByText(vi_['doc.signed.problem.denied'])).closest('small')?.getAttribute('data-problem')).toBe('queue');
    cleanup();
    const empty = world({ queue: { items: [], next_cursor: null } });
    open(empty.h);
    expect(await screen.findByText(vi_['doc.signed.leader.none.text'])).toBeTruthy();
  });
});

describe('SignedUploadScreen (DOC-09): a document signed and numbered in another system (AC-ST-DOC-009-1)', () => {
  async function toExternal(h: Harness, user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await waitingReady();
    await user.click(screen.getByLabelText(vi_['doc.signed.mode.external.label']));
    await readFile(user);
    await waitFor(() => expect(screen.getByLabelText(vi_['doc.signed.external.unit.label']).querySelectorAll('option').length).toBeGreaterThan(1));
    expect(h.read).toHaveBeenCalled();
  }

  async function fillForm(user: ReturnType<typeof userEvent.setup>, overrides: { number?: string; symbol?: string } = {}): Promise<void> {
    await user.selectOptions(screen.getByLabelText(vi_['doc.signed.external.type.label']), 'QD');
    await user.type(screen.getByLabelText(vi_['doc.signed.external.title.label']), ' Decision signed elsewhere ');
    await user.selectOptions(screen.getByLabelText(vi_['doc.signed.external.unit.label']), UNIT);
    fireEvent.change(screen.getByLabelText(vi_['doc.signed.external.issuedOn.label']), { target: { value: '2026-10-22' } });
    await user.selectOptions(screen.getByLabelText(vi_['doc.signed.external.register.label']), REGISTER);
    await user.type(screen.getByLabelText(vi_['doc.signed.external.number.label']), overrides.number ?? '128');
    await user.type(screen.getByLabelText(vi_['doc.signed.external.symbol.label']), overrides.symbol ?? '128/QD-UBND');
    await user.type(screen.getByLabelText(vi_['doc.signed.external.recipients.label']), 'Department of Finance{Enter}Audit Office');
  }

  it('reads the file, takes the declared number, symbol and date, and registers the document as issued', async () => {
    const { h } = world({ commands: { registerExternallySignedDocument: { operation_id: 'o', status: 'ISSUED', resource_version: 1, resource_id: WAITING, symbol: '128/QD-UBND', number: 128 } } });
    open(h);
    const user = userEvent.setup();
    await toExternal(h, user);
    await fillForm(user);
    expect(screen.getByRole('option', { name: new RegExp(fill(vi_['doc.signed.external.register.managed'], { next: 128 })) })).toBeTruthy();
    await user.click(registerButton());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'registerExternallySignedDocument',
      expect.objectContaining({
        body: {
          doc_type_code: 'QD',
          title: 'Decision signed elsewhere',
          file_object_key: 'tenants/t/document/file-1',
          file_sha256: SHA,
          declared_number: 128,
          declared_symbol: '128/QD-UBND',
          declared_issued_on: '2026-10-22',
          register_id: REGISTER,
          drafting_unit_id: UNIT,
          recipients: [{ name: 'Department of Finance' }, { name: 'Audit Office' }],
        },
      }),
    );
    expect((await screen.findByText(new RegExp('128/QD-UBND'), { selector: 'p' })).getAttribute('data-done')).toBe('EXTERNAL');
    expect(screen.getByRole('link', { name: vi_['doc.signed.done.external.next'] }).getAttribute('href')).toBe('/doc/doc-03');
  });

  it('marks every field that is missing and sends nothing', async () => {
    const { h } = world();
    open(h);
    const user = userEvent.setup();
    await toExternal(h, user);
    await user.click(registerButton());
    const form = screen.getByRole('form', { name: vi_['doc.signed.external.title'] });
    expect(within(form).getAllByRole('alert').length).toBe(7);
    expect(screen.getByLabelText(vi_['doc.signed.external.number.label']).getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(vi_['doc.signed.external.number.label']), 'x');
    expect(within(form).queryAllByRole('alert').length).toBe(0);
  });

  it('offers only the open outgoing registers of the year of the date, and says when there is none', async () => {
    const { h } = world({ registers: [registerRow(), registerRow({ id: 'r2', register_code: 'OLD', year: 2025 }), registerRow({ id: 'r3', register_code: 'MIRROR', mode: 'MIRRORED' })] });
    open(h);
    const user = userEvent.setup();
    await toExternal(h, user);
    fireEvent.change(screen.getByLabelText(vi_['doc.signed.external.issuedOn.label']), { target: { value: '2026-10-22' } });
    const options = Array.from(screen.getByLabelText(vi_['doc.signed.external.register.label']).querySelectorAll('option')).map((option) => option.textContent ?? '');
    expect(options.some((text) => text.startsWith('OUT-2026'))).toBe(true);
    expect(options.some((text) => text.startsWith('MIRROR') && text.includes(vi_['doc.signed.external.register.mirrored']))).toBe(true);
    expect(options.some((text) => text.startsWith('OLD'))).toBe(false);
    fireEvent.change(screen.getByLabelText(vi_['doc.signed.external.issuedOn.label']), { target: { value: '2031-01-02' } });
    expect(screen.getByText(vi_['doc.signed.external.register.none'])).toBeTruthy();
  });

  it('shows why the server refused the registration: a number taken, a register that numbers by itself, a closed register, a year, a symbol', { timeout: 60_000 }, async () => {
    const cases: Array<[string, string]> = [
      ['NUMBER_ALREADY_REGISTERED', vi_['doc.signed.problem.numberTaken']],
      ['REGISTER_MODE_MISMATCH', vi_['doc.signed.problem.modeMismatch']],
      ['REGISTER_NOT_OPEN', vi_['doc.signed.problem.registerClosed']],
      ['REGISTER_YEAR_MISMATCH', vi_['doc.signed.problem.yearMismatch']],
      ['SYMBOL_FORMAT_INVALID', vi_['doc.signed.problem.symbolFormat']],
    ];
    for (const [code, message] of cases) {
      const { h } = world({ commands: { registerExternallySignedDocument: problem(code, 409) } });
      open(h);
      const user = userEvent.setup();
      await toExternal(h, user);
      await fillForm(user);
      await user.click(registerButton());
      expect((await screen.findByText(message)).closest('[role="alert"]')).toBeTruthy();
      cleanup();
    }
  });

  it('does not offer a file whose signatures do not hold', async () => {
    const { h } = world({ upload: uploaded({ overall: 'INDETERMINATE', signatures: [signature({ status: 'INDETERMINATE', chain_status: 'INCOMPLETE', findings: ['CHAIN_UNTRUSTED', 'CUSTOM_CODE'] })] }) });
    open(h);
    const user = userEvent.setup();
    await toExternal(h, user);
    expect(registerButton().matches(':disabled')).toBe(true);
    const verdict = screen.getByTestId('verdict');
    expect(within(verdict).getByText(vi_['doc.signed.finding.chainUntrusted'])).toBeTruthy();
    expect(within(verdict).getByText(vi_['doc.signed.finding.other'].replace('{code}', 'CUSTOM_CODE'))).toBeTruthy();
    expect(within(verdict).getByText(vi_['doc.signed.chain.incomplete'])).toBeTruthy();
  });
});

describe('SignedUploadScreen (DOC-09): who may do what', () => {
  it('is read-only for a caller without doc.file.upload, and without the permission of the way chosen', async () => {
    const { h } = world();
    open(h, [READ]);
    await waitingReady();
    expect(screen.getByText(vi_['doc.signed.denied.notice'])).toBeTruthy();
    expect(fileInput().matches(':disabled')).toBe(true);
    expect(readButton().matches(':disabled')).toBe(true);
    cleanup();
    const second = world();
    open(second.h, [UPLOAD, READ]);
    await waitingReady();
    const user = userEvent.setup();
    await readFile(user);
    await user.selectOptions(screen.getByLabelText(vi_['doc.signed.leader.document.label']), WAITING);
    expect(attachButton().matches(':disabled')).toBe(true);
    cleanup();
    const third = world();
    open(third.h, [UPLOAD, ATTACH, READ]);
    await waitingReady();
    await user.click(screen.getByLabelText(vi_['doc.signed.mode.external.label']));
    await readFile(user);
    expect(registerButton().matches(':disabled')).toBe(true);
    expect(third.h.command).not.toHaveBeenCalled();
  });

  it('is read-only for a suspended tenant, whatever the grants say', async () => {
    const { h } = world();
    open(h, ALL, 'READ_ONLY');
    await waitingReady();
    expect(screen.getByText(vi_['doc.signed.frozen.notice'])).toBeTruthy();
    expect(fileInput().matches(':disabled')).toBe(true);
  });

  it('starts over when the tenant changes, and clears the result when the way changes', async () => {
    const { h } = world();
    const view = open(h);
    await waitingReady();
    const user = userEvent.setup();
    await readFile(user);
    await user.click(screen.getByLabelText(vi_['doc.signed.mode.external.label']));
    expect(screen.getByTestId('verdict')).toBeTruthy();
    view.rerenderWith({ permissions: ALL, tenant: SECOND_TENANT });
    await waitingReady();
    expect(screen.queryByTestId('verdict')).toBeNull();
    expect((screen.getByLabelText(vi_['doc.signed.mode.leader.label']) as HTMLInputElement).checked).toBe(true);
  });

  it('has every key of the screen in both catalogues', () => {
    const keys = Object.keys(vi_).filter((key) => key.startsWith('doc.signed.'));
    expect(keys.length).toBeGreaterThan(90);
    for (const key of keys) expect(en_).toHaveProperty([key]);
  });
});
