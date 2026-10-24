import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ContractDraftScreen from './ContractDraftScreen';
import { DOCUMENT, LEAD, MAKER, PACKAGE, PROJECT, READER, client, contractId, detail, mount, party, revision, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-02', 'FR-CTR-02');
const problem = (code: string, status = 422, detailText?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions });
const CREATED_ID = contractId(7);

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const ready = () => waitFor(() => expect(within(screen.getByLabelText(vi_['ctr.form.project.label'])).getAllByRole('option').length).toBeGreaterThan(1));
const creating = (overrides: Partial<World> = {}, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: CREATED_ID })) =>
  client(world(overrides), command);

async function fill(): Promise<void> {
  await ready();
  set(vi_['ctr.form.project.label'], PROJECT);
  set(vi_['ctr.form.package.label'], ` ${PACKAGE} `);
  set(vi_['ctr.form.contractor.label'], LEAD);
  set(vi_['ctr.form.code.label'], ' HD-A-300 ');
  set(vi_['ctr.form.title.label'], ' Thi công cầu ');
  set(vi_['ctr.form.value.label'], '10200000000');
  set(vi_['ctr.form.document.label'], DOCUMENT);
}
const submit = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const create = (): void => submit(vi_['ctr.draft.create.action']);
const save = (): void => submit(vi_['ctr.draft.save.action']);
const commands = (h: ReturnType<typeof creating>) => h.command.mock.calls as Array<[string, { path?: { id: string }; body: Record<string, unknown>; ifMatchVersion?: number }]>;

describe('ContractDraftScreen (CTR-02), drafting a contract', () => {
  it('shows the fields of the screen with the projects and the verified contractors to choose from, and the rules that apply (UI-CTR-02)', async () => {
    mount(<ContractDraftScreen route={ROUTE} />, creating(), { permissions: MAKER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.draft.create.title']);
    const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);
    expect(options(vi_['ctr.form.project.label'])).toEqual([vi_['ctr.form.choose.option'], 'DA-2026-001 · Dự án cầu', 'DA-2026-002 · Dự án đường']);
    // A contractor that is not verified is not offered.
    await waitFor(() => expect(options(vi_['ctr.form.contractor.label'])).toEqual([vi_['ctr.form.choose.option'], 'Công ty Xây dựng An Phát', 'Công ty Cơ khí Bình Minh']));
    expect(options(vi_['ctr.form.type.label'])).toHaveLength(7);
    expect(options(vi_['ctr.form.advance.label'])).toHaveLength(6);
    expect((screen.getByLabelText(vi_['ctr.form.quality.label']) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(vi_['ctr.form.venture.label']) as HTMLInputElement).checked).toBe(false);
    for (const key of ['ctr.draft.rules.ceiling.text', 'ctr.draft.rules.plan.text', 'ctr.draft.rules.contractor.text', 'ctr.draft.rules.venture.text'] as const) expect(screen.getByText(vi_[key])).toBeTruthy();
  });

  it('names what is missing or wrong and sends nothing', async () => {
    const h = creating();
    mount(<ContractDraftScreen route={ROUTE} />, h, { permissions: MAKER });
    await ready();
    create();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['ctr.field.required.error']);
    expect(screen.getByLabelText(vi_['ctr.form.code.label']).getAttribute('aria-invalid')).toBe('true');
    set(vi_['ctr.form.package.label'], 'not an id');
    set(vi_['ctr.form.code.label'], 'x');
    set(vi_['ctr.form.title.label'], 'Cầu');
    set(vi_['ctr.form.value.label'], '0');
    set(vi_['ctr.form.ceiling.label'], '1.5');
    set(vi_['ctr.form.document.label'], DOCUMENT);
    create();
    const messages = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(messages).toEqual(expect.arrayContaining([vi_['ctr.field.invalidId.error'], vi_['ctr.field.zeroAmount.error'], vi_['ctr.field.invalidAmount.error']]));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('creates the draft with what was typed and then offers to open it and, for a venture, to set its members (AC-ST-CTR-001-1)', async () => {
    const h = creating();
    mount(<ContractDraftScreen route={ROUTE} />, h, { permissions: MAKER });
    await fill();
    fireEvent.click(screen.getByLabelText(vi_['ctr.form.venture.label']));
    set(vi_['ctr.form.due.label'], '2027-12-31');
    create();
    const created = await screen.findByTestId('created');
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = commands(h)[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('createContract');
    expect(input.body).toEqual({
      project_id: PROJECT,
      package_id: PACKAGE,
      contractor_id: LEAD,
      code: 'HD-A-300',
      title: 'Thi công cầu',
      type: 'LUMP_SUM',
      advance_category: 'CONSTRUCTION',
      is_joint_venture: true,
      requires_quality_acceptance: true,
      contract_value_vnd: '10200000000',
      document_version_id: DOCUMENT,
      completion_due: '2027-12-31',
    });
    expect(within(created).getByText(vi_['ctr.draft.done.text'])).toBeTruthy();
    expect(within(created).getByRole('link', { name: vi_['ctr.draft.done.open'] }).getAttribute('href')).toBe(`/ctr/ctr-02?id=${CREATED_ID}`);
    expect(within(created).getByRole('link', { name: vi_['ctr.draft.done.parties'] }).getAttribute('href')).toBe(`/ctr/ctr-25?id=${CREATED_ID}`);
    // The form is closed once the draft exists: a second press creates nothing.
    expect(screen.getByLabelText(vi_['ctr.form.code.label']).matches(':disabled')).toBe(true);
    create();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('takes the project and the package from the address, and offers no link to members for a contract of one contractor', async () => {
    const h = creating();
    mount(<ContractDraftScreen route={ROUTE} />, h, { permissions: MAKER, path: `/?project=${PROJECT}&package=${PACKAGE}` });
    await ready();
    await waitFor(() => expect((screen.getByLabelText(vi_['ctr.form.project.label']) as HTMLSelectElement).value).toBe(PROJECT));
    expect((screen.getByLabelText(vi_['ctr.form.package.label']) as HTMLInputElement).value).toBe(PACKAGE);
    set(vi_['ctr.form.contractor.label'], LEAD);
    set(vi_['ctr.form.code.label'], 'HD-1');
    set(vi_['ctr.form.title.label'], 'Cầu');
    set(vi_['ctr.form.value.label'], '5');
    set(vi_['ctr.form.document.label'], DOCUMENT);
    create();
    const created = await screen.findByTestId('created');
    expect(within(created).queryByRole('link', { name: vi_['ctr.draft.done.parties'] })).toBeNull();
    expect(Object.keys(commands(h)[0]?.[1].body ?? {})).not.toContain('estimate_ceiling_vnd');
  });

  it('says the value is above the ceiling the server named, a code that exists is refused as a duplicate, and keeps the form (AC-ST-CTR-001-1, AC-ST-CTR-001-2)', async () => {
    const h = creating({}, () => problem('CONTRACT_VALUE_EXCEEDS_CEILING', 422, 'contract_value_vnd', { ceiling_vnd: '10200000000' }));
    mount(<ContractDraftScreen route={ROUTE} />, h, { permissions: MAKER });
    await fill();
    set(vi_['ctr.form.value.label'], '10300000000');
    create();
    expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.problem.exceedsCeiling.error'].replace('{ceiling}', '10.200.000.000'));
    expect(screen.queryByTestId('created')).toBeNull();
    cleanup();
    const duplicate = creating({}, () => problem('CONTRACT_CODE_DUPLICATE', 409, 'code'));
    mount(<ContractDraftScreen route={ROUTE} />, duplicate, { permissions: MAKER });
    await fill();
    create();
    expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.problem.duplicateCode.error']);
    expect((screen.getByLabelText(vi_['ctr.form.code.label']) as HTMLInputElement).value).toBe(' HD-A-300 ');
  });

  it.each([
    [problem('CONTRACT_VALUE_EXCEEDS_CEILING'), vi_['ctr.problem.exceedsCeilingUnknown.error']],
    [problem('CAPITAL_PLAN_NOT_APPROVED'), vi_['ctr.problem.planNotApproved.error']],
    [problem('PACKAGE_NOT_AWARDED'), vi_['ctr.problem.packageNotAwarded.error']],
    [problem('CONTRACTOR_NOT_VERIFIED'), vi_['ctr.problem.contractorNotVerified.error']],
    [problem('CONTRACTOR_RESTRICTED'), vi_['ctr.problem.contractorRestricted.error']],
    [problem('VALIDATION_FAILED', 422, 'package_id'), vi_['ctr.problem.validationField.error'].replace('{field}', 'package_id')],
    [problem('FIELD_NOT_ALLOWED', 400), vi_['ctr.problem.validation.error']],
    [problem('RESOURCE_NOT_FOUND', 404), vi_['ctr.problem.notFound.error']],
    [problem('SCOPE_DENIED', 403), vi_['ctr.problem.denied.error']],
    [new Error('offline'), vi_['ctr.problem.general.error']],
  ])('shows the sentence of a refusal of the creation (%#)', async (error, sentence) => {
    mount(<ContractDraftScreen route={ROUTE} />, creating({}, () => error), { permissions: MAKER });
    await fill();
    create();
    expect((await screen.findByTestId('problem')).textContent).toBe(sentence);
  });

  it('keeps the form closed for a member who may not create contracts, and in a read-only session', async () => {
    const h = creating();
    const reader = mount(<ContractDraftScreen route={ROUTE} />, h, { permissions: READER });
    await ready();
    expect(screen.getByText(vi_['ctr.readOnly.denied.notice'])).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['ctr.draft.create.action'] }) as HTMLButtonElement).disabled).toBe(true);
    reader.unmount();
    mount(<ContractDraftScreen route={ROUTE} />, h, { permissions: MAKER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByText(vi_['ctr.readOnly.frozen.notice'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('ContractDraftScreen (CTR-02), a draft that exists', () => {
  const opened = (n = 1, overrides: Partial<World> = {}, command?: (operation: string, input: unknown) => unknown) =>
    client(world({ details: [detail(n)], ...overrides }), command ?? (() => ({ operation_id: 'o', status: 'DRAFT', resource_version: 2, resource_id: contractId(n) })));
  const open = (h: ReturnType<typeof opened>, permissions: readonly string[] | undefined = MAKER, n = 1, mode?: 'FULL' | 'READ_ONLY') =>
    mount(<ContractDraftScreen route={ROUTE} />, h, { permissions, path: `/?id=${contractId(n)}`, ...(mode === undefined ? {} : { mode }) });

  it('shows the terms to revise, what cannot change, the revisions and the ceiling (UI-CTR-02)', async () => {
    open(opened());
    await screen.findByTestId('facts');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('HD-A-001 · Hợp đồng số 1');
    const facts = within(screen.getByTestId('facts'));
    expect(facts.getByText('DA-2026-001 · Dự án cầu')).toBeTruthy();
    expect(facts.getByText('Công ty Xây dựng An Phát')).toBeTruthy();
    expect(facts.getByText(vi_['ctr.type.lumpSum.label'])).toBeTruthy();
    expect(facts.getByText(vi_['ctr.advance.construction.label'])).toBeTruthy();
    expect(facts.getAllByText('10.200.000.000 VND')).toHaveLength(2);
    expect((screen.getByLabelText(vi_['ctr.form.title.label']) as HTMLInputElement).value).toBe('Hợp đồng số 1');
    expect((screen.getByLabelText(vi_['ctr.form.value.label']) as HTMLInputElement).value).toBe('10200000000');
    expect(screen.queryByLabelText(vi_['ctr.form.code.label'])).toBeNull();
    const revisions = within(screen.getByTestId('revisions')).getAllByRole('row').slice(1);
    expect(revisions).toHaveLength(1);
    expect(within(revisions[0] as HTMLElement).getByText(vi_['ctr.revision.status.draft'])).toBeTruthy();
    expect(screen.queryByRole('link', { name: vi_['ctr.draft.parties.action'] })).toBeNull();
  });

  it('revises only what differs under the version it saw, refuses a value above the ceiling before sending, and says when nothing changed', async () => {
    const h = opened();
    open(h);
    await screen.findByTestId('facts');
    save();
    expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.draft.unchanged.notice']);
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['ctr.form.value.label'], '10300000000');
    save();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['ctr.field.aboveCeiling.error'].replace('{ceiling}', '10.200.000.000'));
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['ctr.form.value.label'], '9000000000');
    set(vi_['ctr.form.title.label'], ' Tên mới ');
    save();
    expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.draft.saved.notice']);
    const [operation, input] = commands(h)[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('reviseContractDraft');
    expect(input.path.id).toBe(contractId(1));
    expect(input.ifMatchVersion).toBe(1);
    expect(input.body).toEqual({ title: 'Tên mới', contract_value_vnd: '9000000000' });
  });

  it('shows the sentence of a refusal of the revision and keeps what was typed', async () => {
    const h = opened(1, {}, () => problem('VERSION_CONFLICT', 409));
    open(h);
    await screen.findByTestId('facts');
    set(vi_['ctr.form.title.label'], 'Tên mới');
    save();
    expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.problem.versionConflict.error']);
    expect((screen.getByLabelText(vi_['ctr.form.title.label']) as HTMLInputElement).value).toBe('Tên mới');
  });

  it('cancels the draft with a reason, asks for the reason first, and shows the refusal of a draft that moved on', async () => {
    const h = opened();
    open(h);
    await screen.findByTestId('facts');
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.open'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.confirm'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['ctr.field.required.error']);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.back'] }));
    expect(screen.getByRole('button', { name: vi_['ctr.draft.cancel.open'] })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.open'] }));
    set(vi_['ctr.draft.cancel.reason.label'], '  Sai gói thầu  ');
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.confirm'] }));
    expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.draft.cancelled.notice']);
    const [operation, input] = commands(h)[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect([operation, input.path.id, input.ifMatchVersion, input.body]).toEqual(['cancelContractDraft', contractId(1), 1, { reason: 'Sai gói thầu' }]);
    cleanup();
    const refused = opened(1, {}, () => problem('CONTRACT_STATE_INVALID', 409));
    open(refused);
    await screen.findByTestId('facts');
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.open'] }));
    set(vi_['ctr.draft.cancel.reason.label'], 'Lý do');
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.draft.cancel.confirm'] }));
    expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.problem.stateInvalid.error']);
  });

  it('shows a contract that is no longer a draft as read-only, with its history, and offers neither a save nor a cancellation', async () => {
    const cancelled = detail(2, {
      status: 'CANCELLED',
      status_reason: 'Sai gói thầu',
      is_joint_venture: true,
      revisions: [revision(2, { status: 'REJECTED' })],
      status_changes: [{ id: 's1', from_status: 'DRAFT', to_status: 'CANCELLED', reason: 'Sai gói thầu', effective_on: '2026-10-24', command: 'cancelContractDraft', created_at: 'x', created_by: 'y' }],
    });
    open(opened(2, { details: [cancelled] }), MAKER, 2);
    await screen.findByTestId('facts');
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.draft.notDraft.notice']);
    expect((screen.getByRole('button', { name: vi_['ctr.draft.save.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['ctr.draft.cancel.open'] })).toBeNull();
    expect(screen.getByTestId('history').textContent).toContain('2026-10-24: Nháp → Đã hủy. Sai gói thầu');
    expect(within(screen.getByTestId('facts')).getByText('Sai gói thầu')).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['ctr.draft.parties.action'] }).getAttribute('href')).toBe(`/ctr/ctr-25?id=${contractId(2)}`);
    expect(within(screen.getByTestId('revisions')).getByText(vi_['ctr.revision.status.rejected'])).toBeTruthy();
  });

  it('shows a reader the terms without a way to change them, and a read-only session the same', async () => {
    const h = opened();
    const reader = open(h, READER);
    await screen.findByTestId('facts');
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.readOnly.denied.notice']);
    expect(screen.queryByRole('button', { name: vi_['ctr.draft.cancel.open'] })).toBeNull();
    reader.unmount();
    open(h, MAKER, 1, 'READ_ONLY');
    await screen.findByTestId('facts');
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.readOnly.frozen.notice']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows no ceiling to a guest contractor, to whom the server sends none', async () => {
    const guest = detail(1) as Record<string, unknown>;
    delete guest.estimate_ceiling_vnd;
    delete guest.status_changes;
    delete guest.created_by;
    open(opened(1, { details: [guest] }), READER);
    await screen.findByTestId('facts');
    expect(screen.queryByText(vi_['ctr.draft.fact.ceiling'])).toBeNull();
    expect(screen.queryByTestId('history')).toBeNull();
  });

  it('says so when the contract is not in the scope of the member, and shows the error and the denied states of the read', async () => {
    mount(<ContractDraftScreen route={ROUTE} />, client(world({ details: [], missing: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) })), { permissions: MAKER, path: `/?id=${contractId(9)}` });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    cleanup();
    mount(<ContractDraftScreen route={ROUTE} />, client(world({ details: [], missing: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) })), { permissions: MAKER, path: `/?id=${contractId(9)}` });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
  });

  it('shows the placeholder for a contract the read model answers with null', async () => {
    const h = opened();
    (h.client as unknown as { read: () => Promise<unknown> }).read = () => Promise.resolve({ nonsense: true });
    open(h);
    await waitFor(() => expect(screen.getByTestId('no-contract').textContent).toBe(vi_['ctr.draft.noContract.notice']));
  });
});

describe('ContractDraftScreen (CTR-02), members of a venture', () => {
  it('links a joint-venture draft to its members', async () => {
    const venture = detail(3, { is_joint_venture: true, parties: [party(1, LEAD, 'An Phát', 'LEAD', '100.0000', '10200000000')] });
    mount(<ContractDraftScreen route={ROUTE} />, client(world({ details: [venture] })), { permissions: MAKER, path: `/?id=${contractId(3)}` });
    await screen.findByTestId('facts');
    expect(screen.getByRole('link', { name: vi_['ctr.draft.parties.action'] }).getAttribute('href')).toBe(`/ctr/ctr-25?id=${contractId(3)}`);
  });
});
