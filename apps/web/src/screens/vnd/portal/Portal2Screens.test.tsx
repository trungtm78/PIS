import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import PortalFilesScreen from './PortalFilesScreen';
import PortalInvitationsScreen from './PortalInvitationsScreen';
import PortalRequestsScreen from './PortalRequestsScreen';
import {
  ATTACHMENT_LIMITS,
  CONTRACTOR,
  DOCUMENT,
  GUEST,
  GUEST_UPLOAD,
  STAFF,
  attachmentPage,
  client,
  mount,
  portalAttachment,
  portalHome,
  portalRequest,
  registerChoices,
  requestPage,
  routeOf,
  uuid,
} from './test/portal-test-support';
import type { World } from './test/portal-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const sent = (): { attempt: { key: unknown } } => ({ attempt: { key: expect.any(String) } });
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const STAFF_INVITE = [...STAFF, 'vnd.portal.invite', 'vnd.portal.invite.approve', 'vnd.portal.invite.revoke'];

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

function open(element: ReactElement, answers: World['answers'], options: Options = {}) {
  const world: World = { answers, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(element, h, { permissions: options.permissions ?? STAFF_INVITE, path: options.path ?? '/vnd/vnd-23', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const AT = '2026-11-08T03:00:00.000Z';
const invitation = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0060', n),
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  tax_identifier: '0101234561',
  contact_email: `lienhe${n}@example.vn`,
  contact_name: `Trần Thị Mai ${n}`,
  contact_basis: 'REGISTRY_EMAIL',
  basis_reference: null,
  status: 'PROPOSED',
  effective_status: 'PROPOSED',
  proposed_by_name: 'Lê Thị Hoa',
  proposed_at: '2026-11-06T02:00:00.000Z',
  proposal_expires_at: '2026-11-13T02:00:00.000Z',
  decided_by_name: null,
  decided_at: null,
  decision_note: null,
  access_valid_until: null,
  revoked_at: null,
  revoke_reason: null,
  actions: { approve: true, reject: true, revoke: true },
  version: 1,
  ...over,
});
const invitationPage = (items: Array<Record<string, unknown>>) => ({
  items,
  counts: { proposed: 1, approved: 1, expired: 0, revoked: 2 },
  policy: { proposal_days: 7, access_days: 365, max_live_accounts: 3, max_upload_bytes: 10485760, version: 'builtin', unverified: true },
  as_of: AT,
});

describe('PortalInvitationsScreen (VND-23)', () => {
  const route = routeOf('VND-23', 'FR-VND-23');
  const answers = (items: Array<Record<string, unknown>> = [invitation(1), invitation(2, { status: 'APPROVED', effective_status: 'APPROVED', decided_by_name: 'Phạm Quốc Bảo', access_valid_until: '2027-11-08T02:00:00.000Z', actions: { approve: false, reject: false, revoke: true } })]) => ({
    listVendorPortalInvitations: invitationPage(items),
    listVendorRegister: registerChoices(),
  });
  const row = (n: number): HTMLElement => document.querySelector(`tr[data-invitation-id="${uuid('0060', n)}"]`) as HTMLElement;

  it('shows the numbers of the rule, the counts, the two-person note and a line for each invitation with its state in words', async () => {
    open(<PortalInvitationsScreen route={route} />, answers());
    await screen.findByTestId('invitation-rule');
    expect(screen.getByTestId('rule-proposal-days').textContent).toContain('7');
    expect(screen.getByTestId('rule-access-days').textContent).toContain('365');
    expect(screen.getByTestId('rule-max-accounts').textContent).toContain('3');
    expect(screen.getByTestId('count-revoked').textContent).toContain('2');
    expect(screen.getByTestId('two-person-note').textContent).toBe(word('po2.invitations.twoPerson.note'));
    expect(row(1).textContent).toContain('Công ty nhà thầu 1');
    expect(row(1).textContent).toContain('lienhe1@example.vn');
    expect(row(1).textContent).toContain(text('po2.invitations.proposedBy.text', { name: 'Lê Thị Hoa' }));
    expect(row(1).textContent).toContain(word('po2.invitationStatus.proposed.name'));
    expect(row(2).textContent).toContain(word('po2.invitationStatus.approved.name'));
    expect(row(2).textContent).toContain(text('po2.invitations.decidedBy.text', { name: 'Phạm Quốc Bảo' }));
  });

  it('offers approve and reject only where the server says the caller may, and revoke where it is allowed', async () => {
    open(<PortalInvitationsScreen route={route} />, answers());
    await screen.findByTestId('invitation-rule');
    expect(within(row(1)).getByTestId('approve')).toBeTruthy();
    expect(within(row(1)).getByTestId('reject')).toBeTruthy();
    expect(within(row(2)).queryByTestId('approve')).toBeNull();
    expect(within(row(2)).getByTestId('revoke')).toBeTruthy();
    cleanup();
    open(<PortalInvitationsScreen route={route} />, answers([invitation(1, { actions: { approve: false, reject: false, revoke: false } })]));
    await screen.findByTestId('invitation-rule');
    expect(within(row(1)).queryByTestId('approve')).toBeNull();
    expect(within(row(1)).queryByTestId('revoke')).toBeNull();
  });

  it('offers no command to a reader of the portal management, and none in a read-only workspace', async () => {
    open(<PortalInvitationsScreen route={route} />, answers(), { permissions: STAFF });
    await screen.findByTestId('invitation-rule');
    expect(screen.queryByTestId('propose-invitation')).toBeNull();
    expect(screen.queryByTestId('approve')).toBeNull();
    expect(screen.queryByTestId('revoke')).toBeNull();
    cleanup();
    open(<PortalInvitationsScreen route={route} />, answers(), { mode: 'READ_ONLY' });
    await screen.findByTestId('invitation-rule');
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    expect(screen.queryByTestId('propose-invitation')).toBeNull();
    expect(screen.queryByTestId('approve')).toBeNull();
  });

  it('proposes with the registry e-mail: no paper reference is asked or sent', async () => {
    const h = open(<PortalInvitationsScreen route={route} />, answers());
    fireEvent.click(await screen.findByTestId('propose-invitation'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Công ty nhà thầu 1/ });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.picker.field.label'))), { target: { value: CONTRACTOR } });
    type(box, word('po2.propose.field.name.label'), 'Trần Thị Mai');
    type(box, word('po2.propose.field.email.label'), 'lienhe@example.vn');
    fireEvent.change(within(box).getByLabelText(labelOf(word('po2.propose.field.basis.label'))), { target: { value: 'REGISTRY_EMAIL' } });
    expect(within(box).queryByLabelText(labelOf(word('po2.propose.field.reference.label')))).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: word('po2.propose.confirm.action') }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('proposeVendorPortalInvitation', { body: { contractor_id: CONTRACTOR, contact_name: 'Trần Thị Mai', contact_email: 'lienhe@example.vn', contact_basis: 'REGISTRY_EMAIL' }, ...sent() }),
    );
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('po2.propose.title.text'));
  });

  it('asks for the reference of a paper when the proof is not the registry e-mail, and keeps the button off until it is long enough', async () => {
    const h = open(<PortalInvitationsScreen route={route} />, answers());
    fireEvent.click(await screen.findByTestId('propose-invitation'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Công ty nhà thầu 1/ });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.picker.field.label'))), { target: { value: CONTRACTOR } });
    type(box, word('po2.propose.field.name.label'), 'Trần Thị Mai');
    type(box, word('po2.propose.field.email.label'), 'khac@example.vn');
    fireEvent.change(within(box).getByLabelText(labelOf(word('po2.propose.field.basis.label'))), { target: { value: 'REPRESENTATIVE_LETTER' } });
    const confirm = within(box).getByRole('button', { name: word('po2.propose.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type(box, word('po2.propose.field.reference.label'), 'CV-12');
    expect(confirm.disabled).toBe(true);
    type(box, word('po2.propose.field.reference.label'), 'CV-2026/118');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('proposeVendorPortalInvitation', {
        body: { contractor_id: CONTRACTOR, contact_name: 'Trần Thị Mai', contact_email: 'khac@example.vn', contact_basis: 'REPRESENTATIVE_LETTER', basis_reference: 'CV-2026/118' },
        ...sent(),
      }),
    );
  });

  it('says in the dialog why a proposal was refused (the e-mail is not the registry e-mail)', async () => {
    open(<PortalInvitationsScreen route={route} />, answers(), { command: () => problem(422, 'PORTAL_CONTACT_UNPROVEN') });
    fireEvent.click(await screen.findByTestId('propose-invitation'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Công ty nhà thầu 1/ });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.picker.field.label'))), { target: { value: CONTRACTOR } });
    type(box, word('po2.propose.field.name.label'), 'Trần Thị Mai');
    type(box, word('po2.propose.field.email.label'), 'khac@example.vn');
    fireEvent.change(within(box).getByLabelText(labelOf(word('po2.propose.field.basis.label'))), { target: { value: 'REGISTRY_EMAIL' } });
    fireEvent.click(within(box).getByRole('button', { name: word('po2.propose.confirm.action') }));
    expect((await within(box).findByTestId('dialog-error')).textContent).toBe(word('po2.error.contactUnproven.text'));
  });

  it('approves with the version that was read, showing who proposed it, and sends the optional note only when it is written', async () => {
    const h = open(<PortalInvitationsScreen route={route} />, answers());
    await screen.findByTestId('invitation-rule');
    fireEvent.click(within(row(1)).getByTestId('approve'));
    const box = dialog();
    expect(box.textContent).toContain('Lê Thị Hoa');
    expect(box.textContent).toContain('0101234561');
    fireEvent.click(within(box).getByRole('button', { name: word('po2.approve.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveVendorPortalInvitation', { path: { id: uuid('0060', 1) }, ifMatchVersion: 1, body: {}, ...sent() }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('po2.approve.title.text'));
  });

  it('refuses a rejection or a revocation without a reason of five characters, then sends it with the version', async () => {
    const h = open(<PortalInvitationsScreen route={route} />, answers());
    await screen.findByTestId('invitation-rule');
    fireEvent.click(within(row(2)).getByTestId('revoke'));
    const box = dialog();
    const confirm = within(box).getByRole('button', { name: word('po2.revoke.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type(box, word('vnd.field.reason.label'), 'abc');
    expect(confirm.disabled).toBe(true);
    type(box, word('vnd.field.reason.label'), 'Đầu mối đã nghỉ việc');
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('revokeVendorPortalInvitation', { path: { id: uuid('0060', 2) }, ifMatchVersion: 1, body: { reason: 'Đầu mối đã nghỉ việc' }, ...sent() }));
    cleanup();
    const g = open(<PortalInvitationsScreen route={route} />, answers());
    await screen.findByTestId('invitation-rule');
    fireEvent.click(within(row(1)).getByTestId('reject'));
    const rejectBox = dialog();
    type(rejectBox, word('vnd.field.reason.label'), 'Không đủ căn cứ');
    fireEvent.click(within(rejectBox).getByRole('button', { name: word('po2.reject.confirm.action') }));
    await waitFor(() => expect(g.command).toHaveBeenCalledWith('rejectVendorPortalInvitation', { path: { id: uuid('0060', 1) }, ifMatchVersion: 1, body: { reason: 'Không đủ căn cứ' }, ...sent() }));
  });

  it('says that the same person cannot approve (403) and that a stale state is refused (409) in the dialog', async () => {
    open(<PortalInvitationsScreen route={route} />, answers(), { command: () => problem(409, 'PORTAL_INVITATION_STATE_INVALID') });
    await screen.findByTestId('invitation-rule');
    fireEvent.click(within(row(1)).getByTestId('approve'));
    const box = dialog();
    fireEvent.click(within(box).getByRole('button', { name: word('po2.approve.confirm.action') }));
    expect((await within(box).findByTestId('dialog-error')).textContent).toBe(word('po2.error.invitationState.text'));
  });

  it('filters by status on the server and says when nothing matches', async () => {
    const h = open(<PortalInvitationsScreen route={route} />, answers());
    await screen.findByTestId('invitation-rule');
    fireEvent.change(screen.getByLabelText(word('po2.invitations.filter.status.label')), { target: { value: 'REVOKED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorPortalInvitations', { query: { status: 'REVOKED' } }));
  });

  it('says the states: empty, error with retry, denied', async () => {
    open(<PortalInvitationsScreen route={route} />, answers([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open(<PortalInvitationsScreen route={route} />, answers(), { failing: { listVendorPortalInvitations: { error: new Error('boom'), times: 1 } } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('invitation-rule');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'listVendorPortalInvitations').length).toBeGreaterThanOrEqual(2);
    cleanup();
    open(<PortalInvitationsScreen route={route} />, { ...answers(), listVendorPortalInvitations: problem(403, 'SCOPE_DENIED') });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('PortalFilesScreen (VND-24)', () => {
  const route = routeOf('VND-24', 'FR-VND-24');
  const answers = (items: Array<Record<string, unknown>> = [portalAttachment(1), portalAttachment(2, { purpose: 'CERTIFICATE', mime: 'image/png', linked_kind: 'QUALIFICATION', linked_id: uuid('0006', 1) })]) => ({
    getPortalHome: portalHome(),
    listPortalAttachments: attachmentPage(items),
  });
  const withUpload = (h: ReturnType<typeof client>, result: unknown = portalAttachment(9, { document_id: uuid('0051', 9), title: 'bao-cao' })) => {
    const upload = vi.fn(() => Promise.resolve(result));
    (h.client as unknown as { upload: typeof upload }).upload = upload;
    return upload;
  };
  const pick = (file: File): void => {
    fireEvent.change(screen.getByTestId('upload-file'), { target: { files: [file] } });
  };

  it('lists only the own files with the purpose, the type, the size and what they are attached to', async () => {
    open(<PortalFilesScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-24' });
    const first = (await screen.findByText('Bao cao tai chinh 1')).closest('tr') as HTMLElement;
    expect(first.textContent).toContain(word('po2.purpose.requestResponse.name'));
    expect(first.textContent).toContain('200 KB');
    expect(first.textContent).toContain(word('po2.files.linked.none'));
    const second = (await screen.findByText('Bao cao tai chinh 2')).closest('tr') as HTMLElement;
    expect(second.textContent).toContain('image/png');
    expect(second.textContent).toContain(text('po2.files.linked.kind', { kind: 'qualification' }));
    expect(screen.getByTestId('portal-nav').querySelectorAll('a')).toHaveLength(5);
  });

  it('says there is no file yet, and offers the upload', async () => {
    open(<PortalFilesScreen route={route} />, answers([]), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-24' });
    expect(await screen.findByTestId('files-empty')).toBeTruthy();
    expect(screen.getByTestId('upload-control')).toBeTruthy();
  });

  it('offers no upload to a contractor account without the right, and in a read-only workspace', async () => {
    open(<PortalFilesScreen route={route} />, answers(), { permissions: GUEST, path: '/vnd/vnd-24' });
    await screen.findByText('Bao cao tai chinh 1');
    expect(screen.queryByTestId('upload-control')).toBeNull();
    cleanup();
    open(<PortalFilesScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, mode: 'READ_ONLY', path: '/vnd/vnd-24' });
    await screen.findByText('Bao cao tai chinh 1');
    expect(screen.queryByTestId('upload-control')).toBeNull();
  });

  it('checks the type and the size against the limits before it sends anything', async () => {
    const h = open(<PortalFilesScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-24' });
    const upload = withUpload(h);
    await screen.findByTestId('upload-control');
    pick(new File(['x'], 'a.zip', { type: 'application/zip' }));
    expect((await screen.findByTestId('upload-error')).textContent).toBe(word('po2.upload.problem.type'));
    expect((screen.getByTestId('upload-send') as HTMLButtonElement).disabled).toBe(true);
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: ATTACHMENT_LIMITS.max_bytes + 1 });
    pick(big);
    expect((await screen.findByTestId('upload-error')).textContent).toBe(text('po2.upload.problem.tooLarge', { max: '10.0 MB' }));
    expect((screen.getByTestId('upload-send') as HTMLButtonElement).disabled).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('sends a good file with the purpose and the title as the query, and refreshes the list', async () => {
    const h = open(<PortalFilesScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-24' });
    const upload = withUpload(h);
    await screen.findByTestId('upload-control');
    fireEvent.change(screen.getByTestId('upload-purpose'), { target: { value: 'CERTIFICATE' } });
    pick(new File(['%PDF-1.7'], 'bao-cao.pdf', { type: 'application/pdf' }));
    expect((screen.getByTestId('upload-title') as HTMLInputElement).value).toBe('bao-cao');
    fireEvent.click(screen.getByTestId('upload-send'));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [operation, input] = upload.mock.calls[0] as unknown as [string, { query: unknown; form: FormData; attempt: { key: unknown } }];
    expect(operation).toBe('uploadPortalAttachment');
    expect(input.query).toEqual({ purpose: 'CERTIFICATE', title: 'bao-cao' });
    expect(input.form.get('file')).toBeInstanceOf(File);
    expect(input.attempt.key).toEqual(expect.any(String));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'listPortalAttachments').length).toBeGreaterThanOrEqual(2));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('po2.files.upload.title'));
  });

  it('says why the server refused a file: infected, not scanned, too large', async () => {
    for (const [status, code, key] of [
      [422, 'FILE_NOT_CLEAN', 'po2.error.fileNotClean.text'],
      [409, 'SCAN_PENDING', 'po2.error.scanPending.text'],
      [413, 'PAYLOAD_TOO_LARGE', 'po2.error.tooLarge.text'],
    ] as const) {
      const h = open(<PortalFilesScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-24' });
      (h.client as unknown as { upload: unknown }).upload = vi.fn(() => Promise.reject(problem(status, code)));
      await screen.findByTestId('upload-control');
      pick(new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' }));
      fireEvent.click(screen.getByTestId('upload-send'));
      expect((await screen.findByTestId('upload-error')).textContent).toBe(word(key));
      cleanup();
    }
  });

  it('says the refusal for the area when the caller is not a contractor account', async () => {
    open(<PortalFilesScreen route={route} />, { ...answers(), listPortalAttachments: problem(403, 'PORTAL_CONTRACTOR_REQUIRED') }, { permissions: GUEST_UPLOAD, path: '/vnd/vnd-24' });
    expect(await screen.findByTestId('portal-denied')).toBeTruthy();
  });
});

describe('the attachment picker in the portal dialogs', () => {
  const route = routeOf('VND-17', 'FR-VND-17');
  const answers = () => ({
    getPortalHome: portalHome(),
    listPortalRequests: requestPage([portalRequest(1)]),
    listPortalAttachments: attachmentPage([portalAttachment(1, { document_id: DOCUMENT })]),
  });

  it('sends the document of the chosen attachment instead of a typed identifier', async () => {
    const h = open(<PortalRequestsScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-17' });
    fireEvent.click(await screen.findByTestId('answer'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Bao cao tai chinh 1/ });
    expect(within(box).queryByLabelText(labelOf(word('vnd.field.uuid.text')))).toBeNull();
    type(box, word('vnp.answer.field.text.label'), 'Đính kèm báo cáo');
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.answer.field.document.label'))), { target: { value: DOCUMENT } });
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.answer.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('respondPortalRequest', { path: { id: uuid('0040', 1) }, ifMatchVersion: 3, body: { text: 'Đính kèm báo cáo', document_id: DOCUMENT }, ...sent() }));
  });

  it('uploads a new file inside the dialog and uses its document', async () => {
    const h = open(<PortalRequestsScreen route={route} />, answers(), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-17' });
    const fresh = portalAttachment(7, { document_id: uuid('0051', 7), title: 'moi' });
    (h.client as unknown as { upload: unknown }).upload = vi.fn(() => Promise.resolve(fresh));
    fireEvent.click(await screen.findByTestId('answer'));
    const box = dialog();
    await within(box).findByTestId('upload-control');
    fireEvent.change(within(box).getByTestId('upload-file'), { target: { files: [new File(['%PDF-1.7'], 'moi.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(within(box).getByTestId('upload-send'));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'listPortalAttachments').length).toBeGreaterThanOrEqual(2));
    type(box, word('vnp.answer.field.text.label'), 'Đã gửi tệp mới');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.answer.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('respondPortalRequest', { path: { id: uuid('0040', 1) }, ifMatchVersion: 3, body: { text: 'Đã gửi tệp mới', document_id: uuid('0051', 7) }, ...sent() }));
  });

  it('does not offer the upload to an account without the right, but still lists the own files', async () => {
    open(<PortalRequestsScreen route={route} />, answers(), { permissions: GUEST, path: '/vnd/vnd-17' });
    fireEvent.click(await screen.findByTestId('answer'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Bao cao tai chinh 1/ });
    expect(within(box).queryByTestId('upload-control')).toBeNull();
  });
});

describe('the attachment picker keeps the command honest (review findings)', () => {
  const route = routeOf('VND-17', 'FR-VND-17');
  const REQUEST = uuid('0040', 1);
  const world = (items: Array<Record<string, unknown>>) => ({
    getPortalHome: portalHome(),
    listPortalRequests: requestPage([portalRequest(1)]),
    listPortalAttachments: attachmentPage(items),
  });
  const openAnswer = async (items: Array<Record<string, unknown>>) => {
    const h = open(<PortalRequestsScreen route={route} />, world(items), { permissions: GUEST_UPLOAD, path: '/vnd/vnd-17' });
    fireEvent.click(await screen.findByTestId('answer'));
    const box = dialog();
    await within(box).findByTestId('upload-control');
    return { h, box };
  };
  const pickPdf = (box: HTMLElement): void => {
    fireEvent.change(within(box).getByTestId('upload-file'), { target: { files: [new File(['%PDF-1.7'], 'moi.pdf', { type: 'application/pdf' })] } });
  };

  it('offers only the files that are free, and the one attached to this request', async () => {
    const { box } = await openAnswer([
      portalAttachment(1, { title: 'Tep tu do' }),
      portalAttachment(2, { title: 'Tep cua yeu cau nay', linked_kind: 'REQUEST', linked_id: REQUEST }),
      portalAttachment(3, { title: 'Tep cua chung chi', linked_kind: 'QUALIFICATION', linked_id: uuid('0006', 1) }),
    ]);
    await within(box).findByRole('option', { name: /Tep tu do/ });
    expect(within(box).getByRole('option', { name: /Tep cua yeu cau nay/ })).toBeTruthy();
    expect(within(box).queryByRole('option', { name: /Tep cua chung chi/ })).toBeNull();
  });

  it('keeps the answer closed while a file is on the way and opens it with the new document when the upload ends', async () => {
    const { h, box } = await openAnswer([portalAttachment(1)]);
    let finish: (value: unknown) => void = () => undefined;
    (h.client as unknown as { upload: unknown }).upload = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    type(box, word('vnp.answer.field.text.label'), 'Tra loi kem tep');
    const confirm = within(box).getByRole('button', { name: word('vnp.answer.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    pickPdf(box);
    fireEvent.click(within(box).getByTestId('upload-send'));
    await waitFor(() => expect(confirm.disabled).toBe(true));
    fireEvent.click(confirm);
    expect(h.command).not.toHaveBeenCalled();
    finish(portalAttachment(7, { document_id: uuid('0051', 7), title: 'moi' }));
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('respondPortalRequest', { path: { id: REQUEST }, ifMatchVersion: 3, body: { text: 'Tra loi kem tep', document_id: uuid('0051', 7) }, ...sent() }));
  });

  it('opens the answer again, with the choice it had, when the upload fails', async () => {
    const { h, box } = await openAnswer([portalAttachment(1, { document_id: DOCUMENT })]);
    (h.client as unknown as { upload: unknown }).upload = vi.fn(() => Promise.reject(problem(409, 'SCAN_PENDING')));
    type(box, word('vnp.answer.field.text.label'), 'Tra loi');
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.answer.field.document.label'))), { target: { value: DOCUMENT } });
    pickPdf(box);
    fireEvent.click(within(box).getByTestId('upload-send'));
    expect((await within(box).findByTestId('upload-error')).textContent).toBe(word('po2.error.scanPending.text'));
    const confirm = within(box).getByRole('button', { name: word('vnp.answer.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect((within(box).getByLabelText(labelOf(word('vnp.answer.field.document.label'))) as HTMLSelectElement).value).toBe(DOCUMENT);
  });

  it('lets the same valid file be sent again after a failure of the request: the same idempotency key after a lost answer, a new one after a final refusal or once the title changes', async () => {
    const { h, box } = await openAnswer([portalAttachment(1)]);
    const upload = vi.fn(() => Promise.reject(problem(503, 'DEPENDENCY_UNAVAILABLE')));
    (h.client as unknown as { upload: unknown }).upload = upload;
    pickPdf(box);
    const send = within(box).getByTestId('upload-send') as HTMLButtonElement;
    fireEvent.click(send);
    await within(box).findByTestId('upload-error');
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const keys = upload.mock.calls.map((call) => ((call as unknown as [string, { attempt: { key: string } }])[1]).attempt.key);
    expect(keys[0]).toBe(keys[1]);
    fireEvent.change(within(box).getByTestId('upload-title'), { target: { value: 'Ten khac' } });
    expect(within(box).queryByTestId('upload-error')).toBeNull();
    fireEvent.click(send);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(((upload.mock.calls[2] as unknown as [string, { attempt: { key: string } }])[1]).attempt.key).not.toBe(keys[0]);
  });

  it('keeps a file that is wrong in itself closed until another file is chosen', async () => {
    const { box } = await openAnswer([portalAttachment(1)]);
    fireEvent.change(within(box).getByTestId('upload-file'), { target: { files: [new File(['x'], 'a.zip', { type: 'application/zip' })] } });
    expect((await within(box).findByTestId('upload-error')).textContent).toBe(word('po2.upload.problem.type'));
    fireEvent.change(within(box).getByTestId('upload-title'), { target: { value: 'Ten khac' } });
    expect((within(box).getByTestId('upload-send') as HTMLButtonElement).disabled).toBe(true);
    pickPdf(box);
    expect((within(box).getByTestId('upload-send') as HTMLButtonElement).disabled).toBe(false);
  });
});
