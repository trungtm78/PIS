import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import CertificatesScreen from './CertificatesScreen';
import { ALL, CONTRACTOR, DOCUMENT, READER, client, expiry, mount, policy, profileView, qualification, routeOf, staff, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
const route = routeOf('VND-05', 'FR-VND-05');
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const PATH = `/vnd/vnd-05?contractor=${CONTRACTOR}`;
const PACKAGE = uuid('0030', 1);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
  extra?: World['answers'];
}

const sample = () =>
  profileView({
    qualifications: [
      qualification(1),
      qualification(2, { kind: 'SAFETY_CERTIFICATE', certificate_no: 'ATLD-2', grade: null, scope: null, verified_at: null, verified_by_name: null, may_verify: true, state: 'EXPIRING_SECOND', days_left: 20 }),
      qualification(3, { kind: 'TAX_CLEARANCE', certificate_no: 'THUE-3', grade: null, state: 'EXPIRED', days_left: -5, may_verify: false }),
    ],
    key_staff: [staff(1)],
  });

function open(view: Record<string, unknown> = sample(), options: Options = {}) {
  const world: World = { answers: { getVendorContractor: view, ...(options.extra ?? {}) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<CertificatesScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findAllByText(/CCNL-1/);
};
const qualificationRow = (n: number): HTMLElement => document.querySelector(`tr[data-qualification-id="${uuid('0006', n)}"]`) as HTMLElement;

describe('CertificatesScreen (VND-05): the certificates and key staff of one contractor', () => {
  it('lists the certificates with the kind, number and grade, the scope, the issuer, the dates, the state and who checked them', async () => {
    open();
    await loaded();
    const first = qualificationRow(1);
    expect(first.textContent).toContain(word('vnd.kind.constructionActivity.name'));
    expect(first.textContent).toContain('CCNL-1');
    expect(first.textContent).toContain(word('vnd.grade.ii.name'));
    expect(first.textContent).toContain('Công trình dân dụng và giao thông');
    expect(first.textContent).toContain('Bộ Xây dựng');
    expect(first.textContent).toContain('01/01/2024 – 01/01/2027');
    expect(first.textContent).toContain(word('vnd.certState.valid.name'));
    expect(first.textContent).toContain(text('vnd.cert.daysLeft.text', { days: 54 }));
    expect(first.textContent).toContain(word('vnd.certs.verified.yes'));
    expect(first.textContent).toContain(text('vnd.certs.verified.by.text', { name: 'Phạm Quốc Bảo', time: '02/10/2026 09:00' }));
  });

  it('shows an expiring certificate with its days left and an expired one with its days past, and one nobody checked as not checked', async () => {
    open();
    await loaded();
    const expiring = qualificationRow(2);
    expect(expiring.textContent).toContain(word('vnd.certState.expiringSecond.name'));
    expect(expiring.textContent).toContain(text('vnd.cert.daysLeft.text', { days: 20 }));
    expect(expiring.textContent).toContain(word('vnd.certs.verified.no'));
    const expired = qualificationRow(3);
    expect(expired.textContent).toContain(word('vnd.certState.expired.name'));
    expect(expired.textContent).toContain(text('vnd.cert.daysOver.text', { days: 5 }));
  });

  it('says a certificate without an end date has none, and a revoked one is not counted in days', async () => {
    open(profileView({ qualifications: [qualification(1, { expires_on: null, days_left: null }), qualification(2, { state: 'REVOKED', days_left: 30, revoked_at: '2026-10-01T02:00:00.000Z' })], key_staff: [] }));
    await loaded();
    expect(qualificationRow(1).textContent).toContain(word('vnd.certs.expires.none'));
    expect(qualificationRow(2).textContent).toContain(word('vnd.certState.revoked.name'));
    expect(qualificationRow(2).textContent).not.toContain(text('vnd.cert.daysLeft.text', { days: 30 }));
  });

  it('says the rule of the two warnings with its "i" and the unverified flag, for the certificates and for the staff', async () => {
    open(profileView({ policies: { ...(profileView().policies as object), qualification_expiry: policy('VENDOR_EXPIRY_WARNING', { formula: 'Cảnh báo 60 và 30 ngày' }) } }));
    await loaded();
    const buttons = screen.getAllByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.certs.figure.expiry.name') }) });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    const panel = screen.getByRole('dialog', { name: word('vnd.certs.figure.expiry.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Cảnh báo 60 và 30 ngày');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
    expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(0);
  });

  it('lists the key staff with the role, the certificate, the state and the check', async () => {
    open();
    await loaded();
    const row = document.querySelector(`tr[data-staff-id="${uuid('0007', 1)}"]`) as HTMLElement;
    expect(row.textContent).toContain('Trần Văn Cường 1');
    expect(row.textContent).toContain(word('vnd.staffRole.projectManager.name'));
    expect(row.textContent).toContain('Chỉ huy trưởng công trường · CH-1');
    expect(row.textContent).toContain(word('vnd.certState.expiringSecond.name'));
    expect(row.textContent).toContain(text('vnd.cert.daysLeft.text', { days: 37 }));
    expect(row.textContent).toContain(word('vnd.certs.verified.no'));
  });

  it('says there is nothing when the contractor has no certificate and no staff', async () => {
    open(profileView({ qualifications: [], key_staff: [] }));
    await screen.findByTestId('qualifications-empty');
    expect(screen.getByTestId('staff-empty')).toBeTruthy();
  });

  describe('checking against the original', () => {
    it('offers the check only for a certificate that is not checked and that the answer lets the caller check', async () => {
      open();
      await loaded();
      expect(within(qualificationRow(1)).queryByTestId('verify')).toBeNull();
      expect(within(qualificationRow(2)).getByTestId('verify')).toBeTruthy();
      expect(within(qualificationRow(3)).queryByTestId('verify')).toBeNull();
      expect(screen.getByTestId('verify-staff')).toBeTruthy();
    });

    it('checks a certificate under its version, in the route of its subject', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(within(qualificationRow(2)).getByTestId('verify'));
      const form = dialog(word('vnd.certs.verify.title'));
      expect(form.textContent).toContain('ATLD-2');
      expect(form.textContent).toContain(word('vnd.certs.verify.note'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.verify.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('verifyVendorCertificate', { path: { subject: 'qualification', id: uuid('0006', 2) }, ifMatchVersion: 2, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.certs.verify.title'));
    });

    it('checks a key person in the route of the key staff', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('verify-staff'));
      const form = dialog(word('vnd.certs.verify.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.verify.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('verifyVendorCertificate', { path: { subject: 'key-staff', id: uuid('0007', 1) }, ifMatchVersion: 1, attempt: { key: expect.any(String) } }));
    });

    it('says in the dialog that another person has to check it when the server refuses the person who entered it', async () => {
      open(sample(), { command: () => Promise.reject(problem(403, 'SELF_APPROVAL_DENIED')) });
      await loaded();
      fireEvent.click(within(qualificationRow(2)).getByTestId('verify'));
      const form = dialog(word('vnd.certs.verify.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.verify.confirm') }));
      const alert = await within(form).findByRole('alert');
      expect(alert.textContent).toBe(word('vnd.error.selfApproval.text'));
      expect(alert.getAttribute('data-code')).toBe('SELF_APPROVAL_DENIED');
    });

    it('says a changed version with a way to read the record again', async () => {
      open(sample(), { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')) });
      await loaded();
      fireEvent.click(within(qualificationRow(2)).getByTestId('verify'));
      const form = dialog(word('vnd.certs.verify.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.verify.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });
  });

  describe('revoking', () => {
    it('revokes with a reason of at least five characters, under the version', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(within(qualificationRow(1)).getByTestId('revoke'));
      const form = dialog(word('vnd.certs.revoke.title'));
      const send = within(form).getByRole('button', { name: word('vnd.certs.revoke.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'abc');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Chứng chỉ bị cơ quan cấp thu hồi');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('revokeVendorCertificate', { path: { subject: 'qualification', id: uuid('0006', 1) }, ifMatchVersion: 2, body: { reason: 'Chứng chỉ bị cơ quan cấp thu hồi' }, attempt: { key: expect.any(String) } }));
    });

    it('does not offer to revoke what is already revoked, nor without the right to manage', async () => {
      open(profileView({ qualifications: [qualification(1, { state: 'REVOKED' })], key_staff: [] }));
      await loaded();
      expect(screen.queryByTestId('revoke')).toBeNull();
      cleanup();
      open(profileView({ actions: { ...(profileView().actions as object), manage_certificates: false } }));
      await loaded();
      expect(screen.queryByTestId('revoke')).toBeNull();
      expect(screen.queryByTestId('add-qualification')).toBeNull();
      expect(screen.queryByTestId('add-staff')).toBeNull();
    });
  });

  describe('adding', () => {
    it('adds a certificate with the body of the request', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('add-qualification'));
      const form = dialog(word('vnd.certs.add.title'));
      const send = within(form).getByRole('button', { name: word('vnd.certs.add.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.certs.field.kind.label'), 'DESIGN_CONSULTING');
      type(form, word('vnd.certs.field.number.label'), ' TK-77 ');
      type(form, word('vnd.certs.field.grade.label'), 'I');
      type(form, word('vnd.certs.field.scope.label'), 'Thiết kế cầu đường');
      type(form, word('vnd.certs.field.issuer.label'), 'Sở Xây dựng Cao Bằng');
      type(form, word('vnd.certs.field.issued.label'), '2025-03-01');
      type(form, word('vnd.certs.field.expires.label'), '2030-03-01');
      type(form, word('vnd.certs.field.document.label'), DOCUMENT);
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('addVendorQualification', { path: { id: CONTRACTOR }, body: { kind: 'DESIGN_CONSULTING', certificate_no: 'TK-77', grade: 'I', scope: 'Thiết kế cầu đường', issuer: 'Sở Xây dựng Cao Bằng', issued_on: '2025-03-01', expires_on: '2030-03-01', document_id: DOCUMENT }, attempt: { key: expect.any(String) } }));
    });

    it('sends only what was filled, and keeps the lengths of the request', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('add-qualification'));
      const form = dialog(word('vnd.certs.add.title'));
      type(form, word('vnd.certs.field.kind.label'), 'OTHER');
      type(form, word('vnd.certs.field.number.label'), 'X-1');
      type(form, word('vnd.certs.field.issuer.label'), 'A');
      type(form, word('vnd.certs.field.issued.label'), '2025-03-01');
      const send = within(form).getByRole('button', { name: word('vnd.certs.add.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.certs.field.issuer.label'), 'Sở');
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('addVendorQualification', expect.objectContaining({ body: { kind: 'OTHER', certificate_no: 'X-1', issuer: 'Sở', issued_on: '2025-03-01' } })));
    });

    it('adds key staff with the body of the request', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('add-staff'));
      const form = dialog(word('vnd.certs.staff.add.title'));
      type(form, word('vnd.certs.field.role.label'), 'SUPERVISOR');
      type(form, word('vnd.certs.field.person.label'), 'Lý Văn Dũng');
      type(form, word('vnd.certs.field.title.label'), 'Giám sát thi công xây dựng');
      type(form, word('vnd.certs.field.issued.label'), '2024-05-01');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.staff.add.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('addVendorKeyStaff', { path: { id: CONTRACTOR }, body: { staff_role: 'SUPERVISOR', person_name: 'Lý Văn Dũng', qualification_title: 'Giám sát thi công xây dựng', issued_on: '2024-05-01' }, attempt: { key: expect.any(String) } }));
    });

    it('shows the field detail of a 422', async () => {
      open(sample(), { command: () => Promise.reject(problem(422, 'VALIDATION_FAILED', 'issued_on: in the future')) });
      await loaded();
      fireEvent.click(screen.getByTestId('add-staff'));
      const form = dialog(word('vnd.certs.staff.add.title'));
      type(form, word('vnd.certs.field.role.label'), 'SUPERVISOR');
      type(form, word('vnd.certs.field.person.label'), 'Lý Văn Dũng');
      type(form, word('vnd.certs.field.title.label'), 'Giám sát thi công xây dựng');
      type(form, word('vnd.certs.field.issued.label'), '2024-05-01');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.staff.add.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toContain('issued_on: in the future');
    });
  });

  describe('the requirements of a package', () => {
    const requirements = (items: Array<Record<string, unknown>>) => ({ package_id: PACKAGE, requirements: items, as_of: '2026-11-08T03:00:00.000Z' });
    const load = async (): Promise<void> => {
      fireEvent.change(screen.getByLabelText(word('vnd.certs.requirements.package.label')), { target: { value: PACKAGE } });
      fireEvent.click(screen.getByTestId('load-requirements'));
      await screen.findByTestId('set-requirements');
    };

    it('asks for a package before it reads anything, and refuses an id that is not an identifier', async () => {
      const { h } = open();
      await loaded();
      expect(screen.getByTestId('requirements-choose')).toBeTruthy();
      const button = screen.getByTestId('load-requirements') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText(word('vnd.certs.requirements.package.label')), { target: { value: 'goi-thau' } });
      expect(button.disabled).toBe(true);
      expect(screen.getByText(word('vnd.field.uuid.text'))).toBeTruthy();
      expect(h.read).not.toHaveBeenCalledWith('getVendorPackageRequirements', expect.anything());
    });

    it('shows the requirements of the package with the gap of this contractor against each', async () => {
      const { h } = open(sample(), {
        extra: {
          getVendorPackageRequirements: requirements([
            { kind: 'CONSTRUCTION_ACTIVITY', min_grade: 'II', scope_keyword: 'giao thông' },
            { kind: 'SAFETY_CERTIFICATE', min_grade: null, scope_keyword: null },
            { kind: 'TAX_CLEARANCE', min_grade: null, scope_keyword: null },
            { kind: 'QUALITY_MANAGEMENT_ISO9001', min_grade: null, scope_keyword: null },
          ]),
        },
      });
      await loaded();
      await load();
      expect(h.read).toHaveBeenCalledWith('getVendorPackageRequirements', { path: { id: PACKAGE } });
      const rows = Array.from(document.querySelectorAll('tr[data-kind]'));
      expect(rows[0]?.textContent).toContain(word('vnd.certs.requirements.met.text'));
      expect(rows[0]?.textContent).toContain(word('vnd.grade.ii.name'));
      expect(rows[0]?.textContent).toContain('giao thông');
      expect(rows[1]?.textContent).toContain(word('vnd.gap.notVerified.name'));
      expect(rows[2]?.textContent).toContain(word('vnd.gap.expired.name'));
      expect(rows[3]?.textContent).toContain(word('vnd.gap.missing.name'));
    });

    it('takes the package from the address', async () => {
      const { h } = open(sample(), { path: `${PATH}&package=${PACKAGE}`, extra: { getVendorPackageRequirements: requirements([]) } });
      await loaded();
      await screen.findByTestId('requirements-empty');
      expect(h.read).toHaveBeenCalledWith('getVendorPackageRequirements', { path: { id: PACKAGE } });
    });

    it('sets the requirements as a whole, starting from the current list, with the grade and the word as null when empty', async () => {
      const { h } = open(sample(), { extra: { getVendorPackageRequirements: requirements([{ kind: 'CONSTRUCTION_ACTIVITY', min_grade: 'II', scope_keyword: 'giao thông' }]) } });
      await loaded();
      await load();
      fireEvent.click(screen.getByTestId('set-requirements'));
      const form = dialog(word('vnd.certs.requirements.title'));
      expect((within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.certs.requirements.column.kind'), row: 1 })) as HTMLSelectElement).value).toBe('CONSTRUCTION_ACTIVITY');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.requirements.add.action') }));
      const send = within(form).getByRole('button', { name: word('vnd.certs.requirements.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      fireEvent.change(within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.certs.requirements.column.kind'), row: 2 })), { target: { value: 'SAFETY_CERTIFICATE' } });
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('setVendorPackageRequirements', { path: { id: PACKAGE }, body: { requirements: [{ kind: 'CONSTRUCTION_ACTIVITY', min_grade: 'II', scope_keyword: 'giao thông' }, { kind: 'SAFETY_CERTIFICATE', min_grade: null, scope_keyword: null }] }, attempt: { key: expect.any(String) } }));
    });

    it('removes a requirement', async () => {
      const { h } = open(sample(), { extra: { getVendorPackageRequirements: requirements([{ kind: 'CONSTRUCTION_ACTIVITY', min_grade: null, scope_keyword: null }, { kind: 'TAX_CLEARANCE', min_grade: null, scope_keyword: null }]) } });
      await loaded();
      await load();
      fireEvent.click(screen.getByTestId('set-requirements'));
      const form = dialog(word('vnd.certs.requirements.title'));
      fireEvent.click(within(form).getByRole('button', { name: text('vnd.certs.requirements.remove.label', { row: 1 }) }));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.requirements.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('setVendorPackageRequirements', expect.objectContaining({ body: { requirements: [{ kind: 'TAX_CLEARANCE', min_grade: null, scope_keyword: null }] } })));
    });

    it('says a failed read of the package in place and offers a retry', async () => {
      open(sample(), { path: `${PATH}&package=${PACKAGE}`, failing: { getVendorPackageRequirements: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } }, extra: { getVendorPackageRequirements: requirements([]) } });
      await loaded();
      const error = await screen.findByTestId('requirements-error');
      fireEvent.click(within(error).getByRole('button', { name: word('states.retry.action') }));
      await screen.findByTestId('requirements-empty');
    });

    it('offers to set the requirements only with the right to write certificates', async () => {
      open(sample(), { permissions: READER, extra: { getVendorPackageRequirements: requirements([]) } });
      await loaded();
      fireEvent.change(screen.getByLabelText(word('vnd.certs.requirements.package.label')), { target: { value: PACKAGE } });
      fireEvent.click(screen.getByTestId('load-requirements'));
      await screen.findByTestId('requirements-empty');
      expect(screen.queryByTestId('set-requirements')).toBeNull();
    });
  });

  describe('read-only and states', () => {
    it('offers no command in a read-only workspace', async () => {
      open(sample(), { mode: 'READ_ONLY' });
      await loaded();
      for (const id of ['add-qualification', 'add-staff', 'verify', 'verify-staff', 'revoke', 'revoke-staff']) expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
    });

    it('LOADING, ERROR with retry, FORBIDDEN, EMPTY for a contractor that is not there', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<CertificatesScreen route={route} />, pending, { permissions: ALL, path: PATH });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      open(sample(), { failing: { getVendorContractor: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
      cleanup();
      open(sample(), { failing: { getVendorContractor: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
      cleanup();
      open(sample(), { failing: { getVendorContractor: { error: problem(404, 'RESOURCE_NOT_FOUND'), times: 9 } } });
      expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    });

    it('STALE: keeps the last reading when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { getVendorContractor: () => (++calls === 1 ? sample() : problem(500, 'INTERNAL_ERROR')) } };
      const mounted = mount(<CertificatesScreen route={route} />, client(world), { permissions: ALL, path: PATH });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(screen.getAllByText(/CCNL-1/).length).toBeGreaterThan(0);
    });
  });
});

describe('CertificatesScreen (VND-05): the watch over every contractor', () => {
  const watch = (items: Array<Record<string, unknown>> = [expiry(1), expiry(2, { contractor_id: uuid('0001', 2), contractor_name: 'Công ty nhà thầu 2', subject: 'KEY_STAFF', label: 'Chỉ huy trưởng A', expires_on: '2026-11-01', state: 'EXPIRED' }), expiry(3, { expires_on: '2026-11-28', state: 'EXPIRING_FIRST' })], options: Options = {}) => {
    const world: World = { answers: { listVendorExpiries: { items, policy: policy('VENDOR_EXPIRY_WARNING'), as_of: '2026-11-08T03:00:00.000Z' }, ...(options.extra ?? {}) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
    const h = client(world, options.command);
    mount(<CertificatesScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: options.path ?? '/vnd/vnd-05', ...(options.mode === undefined ? {} : { mode: options.mode }) });
    return { h, world };
  };
  const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-expiry-id]'));

  it('lists what is running out for every contractor, with the days left or past against the day of the answer', async () => {
    watch();
    await screen.findAllByRole('link', { name: 'Công ty nhà thầu 1' });
    const [soon, expired, first] = rows();
    expect(soon?.textContent).toContain(word('vnd.subject.qualification.name'));
    expect(soon?.textContent).toContain('CCNL-1');
    expect(soon?.textContent).toContain('01/12/2026');
    expect(soon?.textContent).toContain(text('vnd.cert.daysLeft.text', { days: 23 }));
    expect(soon?.textContent).toContain(word('vnd.certState.expiringSecond.name'));
    expect(expired?.textContent).toContain(word('vnd.subject.keyStaff.name'));
    expect(expired?.textContent).toContain(text('vnd.cert.daysOver.text', { days: 7 }));
    expect(first?.textContent).toContain(word('vnd.certState.expiringFirst.name'));
    expect(within(expired as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 2' }).getAttribute('href')).toBe(`/vnd/vnd-05?contractor=${uuid('0001', 2)}`);
  });

  it('says the rule with its "i" and the unverified flag', async () => {
    watch();
    await screen.findAllByRole('link', { name: 'Công ty nhà thầu 1' });
    expect(screen.getAllByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.certs.figure.expiry.name') }) }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(0);
  });

  it('filters by the state of the warning', async () => {
    watch();
    await screen.findAllByRole('link', { name: 'Công ty nhà thầu 1' });
    fireEvent.change(screen.getByLabelText(word('vnd.certs.watch.state.label')), { target: { value: 'EXPIRED' } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('Chỉ huy trưởng A');
    fireEvent.change(screen.getByLabelText(word('vnd.certs.watch.state.label')), { target: { value: '' } });
    expect(rows()).toHaveLength(3);
  });

  it('EMPTY: says nothing is running out, and offers to clear a filter that found nothing', async () => {
    watch([]);
    expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    cleanup();
    watch([expiry(1)]);
    await screen.findAllByRole('link', { name: 'Công ty nhà thầu 1' });
    fireEvent.change(screen.getByLabelText(word('vnd.certs.watch.state.label')), { target: { value: 'EXPIRED' } });
    expect(await screen.findByText(word('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('ui.dataTable.clearFilters') }));
    expect(rows()).toHaveLength(1);
  });

  it('LOADING, ERROR with retry, FORBIDDEN', async () => {
    const pending = client({ answers: {} });
    pending.read.mockImplementation(() => new Promise(() => undefined));
    mount(<CertificatesScreen route={route} />, pending, { permissions: ALL, path: '/vnd/vnd-05' });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    watch(undefined, { failing: { listVendorExpiries: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findAllByRole('link', { name: 'Công ty nhà thầu 1' });
    cleanup();
    watch(undefined, { failing: { listVendorExpiries: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
  });

  it('STALE: keeps the last list when a refresh fails', async () => {
    let calls = 0;
    const world: World = { answers: { listVendorExpiries: () => (++calls === 1 ? { items: [expiry(1)], policy: policy('VENDOR_EXPIRY_WARNING'), as_of: '2026-11-08T03:00:00.000Z' } : problem(500, 'INTERNAL_ERROR')) } };
    const mounted = mount(<CertificatesScreen route={route} />, client(world), { permissions: ALL, path: '/vnd/vnd-05' });
    await screen.findAllByRole('link', { name: 'Công ty nhà thầu 1' });
    await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
    expect(await screen.findByTestId('stale-notice')).toBeTruthy();
    expect(rows()).toHaveLength(1);
  });

  it('shows the requirements of a package here too, without gaps, and says to choose a contractor for them', async () => {
    watch(undefined, { path: `/vnd/vnd-05?package=${PACKAGE}`, extra: { getVendorPackageRequirements: { package_id: PACKAGE, requirements: [{ kind: 'TAX_CLEARANCE', min_grade: null, scope_keyword: null }], as_of: '2026-11-08T03:00:00.000Z' } } });
    await waitFor(() => expect(screen.getByText(word('vnd.certs.requirements.noContractor.text'))).toBeTruthy());
    expect(document.querySelector('tr[data-kind="TAX_CLEARANCE"]')?.textContent).not.toContain(word('vnd.certs.requirements.met.text'));
  });
});
