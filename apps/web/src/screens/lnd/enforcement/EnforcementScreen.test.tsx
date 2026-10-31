import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PROJECT, UNIT_TTQD, UNIT_XA, client, household, mount, parcel, planRecord, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import EnforcementScreen from './EnforcementScreen';

const ROUTE = routeOf('LND-09', 'FR-LND-09');
const ENFORCER = ['land.enforce.write', 'land.read'];
const READER = ['land.read'];
const OK = { operation_id: 'o', status: 'NOTICE', resource_version: 2, resource_id: 'x' };
const word = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const DOCUMENT = '00000000-0000-4000-8000-0000000000D1';
const caseId = (n: number): string => `00000000-0000-4000-8000-0000000001c${n}`;
const enforcement = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: caseId(n),
  project_id: PROJECT,
  parcel: { id: `00000000-0000-4000-8000-00000010000${n}`, parcel_code: `TB-${n}/10`, status: 'PLAN_APPROVED' },
  household: { id: `00000000-0000-4000-8000-00000030000${n}`, household_code: `HH-00000${n}`, head_name: `N***** V** A${n}` },
  plan_id: '00000000-0000-4000-8000-000000500001',
  owner_unit_id: UNIT_XA,
  authority_unit_id: UNIT_TTQD,
  step: 'PERSUASION',
  suspended_from: null,
  started_on: '2026-01-05',
  decision_document_version_id: null,
  planned_on: null,
  executed_on: null,
  legal_basis: 'Điều 89 Luật Đất đai 2024',
  suspend_reason: null,
  allowed: { advance: true, suspend: true, next: 'NOTICE' },
  version: 1,
  ...overrides,
});

afterEach(cleanup);

function open(options: { cases?: unknown[]; command?: (operation: string, input: unknown) => unknown; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; path?: string; failing?: boolean; parcels?: unknown[]; plans?: unknown[] } = {}): Harness {
  const h = client(
    world({
      enforcement: (options.cases ?? []) as never,
      parcels: (options.parcels ?? [parcel(1, { status: 'PLAN_APPROVED', recovery_decision_on: '2026-01-01' }), parcel(2, { status: 'SURVEYED' }), parcel(3, { status: 'PAID', recovery_decision_on: null })]) as never,
      households: [household(1)] as never,
      plans: (options.plans ?? [planRecord(1, { status: 'APPROVED' }), planRecord(2, { status: 'DRAFT' })]) as never,
      ...(options.failing === true ? { failing: new Set(['listEnforcementCases']) } : {}),
    }),
    options.command ?? (() => OK),
  );
  mount(<EnforcementScreen route={ROUTE} />, h, { permissions: options.permissions ?? ENFORCER, ...(options.mode === undefined ? {} : { mode: options.mode }), path: options.path ?? `/lnd/lnd-09?project=${PROJECT}` });
  return h;
}
const sent = (h: Harness) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { body?: Record<string, unknown>; path?: { id: string }; ifMatchVersion?: number }) }));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const fill = (label: string, value: string): void => {
  fireEvent.change(within(dialog()).getByLabelText(label), { target: { value } });
};
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const openAdvance = async (parcelCode = 'TB-1/10'): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: word('lnd.enforcement.advance.aria', { parcel: parcelCode }) }));
};
const chooseOptions = async (label: string): Promise<HTMLSelectElement> => {
  const select = (await within(dialog()).findByLabelText(label)) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  return select;
};
const fillStart = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: word('lnd.enforcement.start.action') }));
  const parcels = await chooseOptions(word('lnd.enforcement.field.parcel.label'));
  fireEvent.change(parcels, { target: { value: parcels.options[1]?.value } });
  const households = await chooseOptions(word('lnd.enforcement.field.household.label'));
  fireEvent.change(households, { target: { value: households.options[1]?.value } });
  const plans = await chooseOptions(word('lnd.enforcement.field.plan.label'));
  fireEvent.change(plans, { target: { value: plans.options[1]?.value } });
  const units = await chooseOptions(word('lnd.enforcement.field.authority.label'));
  fireEvent.change(units, { target: { value: UNIT_TTQD } });
  fill(word('lnd.enforcement.field.basis.label'), ' Điều 89 ');
  fill(word('lnd.enforcement.field.started.label'), '2026-01-05');
};

describe('EnforcementScreen (LND-09): the enforcement of a land recovery', () => {
  it('UI-LND-09: asks for a project first, then lists the cases with the household masked, the step in words and the days', async () => {
    open({
      cases: [enforcement(1), enforcement(2, { step: 'EXECUTING', planned_on: '2026-02-01', executed_on: null }), enforcement(3, { step: 'SUSPENDED', suspended_from: 'NOTICE', suspend_reason: 'Hộ khiếu nại', household: null })],
      path: '/lnd/lnd-09',
    });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(word('lnd.enforcement.project.notice'));
    expect(screen.getByTestId('privacy-note').textContent).toBe(word('lnd.enforcement.privacy.note'));
    fireEvent.change(await screen.findByLabelText(word('lnd.enforcement.project.label')), { target: { value: PROJECT } });
    const rows = within(await screen.findByTestId('cases')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('TB-1/10');
    expect(rows[0]?.textContent).toContain('HH-000001');
    expect(rows[0]?.textContent).toContain('N***** V** A1');
    expect(rows[0]?.textContent).toContain(word('lnd.enforcement.step.persuasion'));
    expect(rows[0]?.textContent).toContain('2026-01-05');
    expect(rows[1]?.textContent).toContain(word('lnd.enforcement.step.executing'));
    expect(rows[1]?.textContent).toContain('2026-02-01');
    expect(rows[2]?.textContent).toContain(word('lnd.enforcement.step.suspended'));
    expect(within(rows[2] as HTMLElement).getByTestId('suspend-reason').textContent).toBe('Hộ khiếu nại');
    expect(rows[2]?.textContent).toContain('—');
    fireEvent.change(screen.getByLabelText(word('lnd.enforcement.project.label')), { target: { value: '' } });
    expect(await screen.findByTestId('choose-project')).toBeTruthy();
  });

  it('says in words that the project has no case, and shows a reader the list and no action', async () => {
    open({ permissions: READER, cases: [enforcement(1)] });
    expect((await screen.findByTestId('cases')).textContent).toContain('TB-1/10');
    expect(screen.queryByRole('button', { name: word('lnd.enforcement.start.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: word('lnd.enforcement.advance.aria', { parcel: 'TB-1/10' }) })).toBeNull();
    cleanup();
    open();
    expect((await screen.findByTestId('empty')).textContent).toBe(word('lnd.enforcement.empty.notice'));
  });

  it('takes no command in the read-only mode', async () => {
    open({ mode: 'READ_ONLY', cases: [enforcement(1)] });
    await screen.findByTestId('cases');
    expect(screen.queryByRole('button', { name: word('lnd.enforcement.start.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: word('lnd.enforcement.advance.aria', { parcel: 'TB-1/10' }) })).toBeNull();
  });

  it('opens a case for a parcel with a recovery decision, a household and an approved plan, and sends the unit of the household as the unit that answers', async () => {
    const h = open();
    await fillStart();
    const parcels = within(dialog()).getByLabelText(word('lnd.enforcement.field.parcel.label')) as HTMLSelectElement;
    expect(Array.from(parcels.options).map((option) => option.textContent)).toEqual(['—', 'TB-1/10']);
    const plans = within(dialog()).getByLabelText(word('lnd.enforcement.field.plan.label')) as HTMLSelectElement;
    expect(Array.from(plans.options).map((option) => option.textContent)).toEqual(['—', `PA-0001 · ${word('lnd.enforcement.field.plan.revision', { revision: 1 })}`]);
    submit(word('lnd.enforcement.start.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'startEnforcement',
      body: { project_id: PROJECT, owner_unit_id: UNIT_XA, authority_unit_id: UNIT_TTQD, legal_basis: 'Điều 89', started_on: '2026-01-05' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says there is no parcel to open a case for when none has a recovery decision', async () => {
    open({ parcels: [parcel(2, { status: 'SURVEYED' })] });
    fireEvent.click(await screen.findByRole('button', { name: word('lnd.enforcement.start.action') }));
    expect(await within(dialog()).findByText(word('lnd.enforcement.field.parcel.none'))).toBeTruthy();
  });

  it('asks for every field before it asks the server, and refuses a day that cannot be one', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: word('lnd.enforcement.start.action') }));
    submit(word('lnd.enforcement.start.submit'));
    expect(await within(dialog()).findAllByText(word('lnd.enforcement.field.required.error'))).toHaveLength(6);
    fill(word('lnd.enforcement.field.basis.label'), 'x'.repeat(2001));
    fill(word('lnd.enforcement.field.started.label'), '2999-01-01');
    expect(within(dialog()).getByText(word('lnd.enforcement.field.future.error'))).toBeTruthy();
    expect(within(dialog()).getByText(word('lnd.enforcement.field.invalid.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.started.label'), '');
    submit(word('lnd.enforcement.start.submit'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    ['PRECONDITION_NOT_MET', 422, { reason: 'PARCEL_STATUS' }, word('lnd.enforcement.problem.precondition', { reason: word('lnd.enforcement.reason.parcel') })],
    ['PRECONDITION_NOT_MET', 422, { reason: 'RECOVERY_DECISION_MISSING' }, word('lnd.enforcement.problem.precondition', { reason: word('lnd.enforcement.reason.decision') })],
    ['PRECONDITION_NOT_MET', 422, { reason: 'PLAN_NOT_APPROVED' }, word('lnd.enforcement.problem.precondition', { reason: word('lnd.enforcement.reason.plan') })],
    ['PRECONDITION_NOT_MET', 422, { reason: 'HOUSEHOLD_NOT_ON_PARCEL' }, word('lnd.enforcement.problem.precondition', { reason: word('lnd.enforcement.reason.household') })],
    ['PRECONDITION_NOT_MET', 422, {}, word('lnd.enforcement.problem.precondition', { reason: word('lnd.enforcement.reason.unknown') })],
    ['PAYMENT_NOT_OFFERED', 422, { reason: 'NO_PLAN_OR_HOUSEHOLD' }, word('lnd.enforcement.problem.paymentNotOffered', { reason: word('lnd.enforcement.reason.nobody') })],
    ['PAYMENT_NOT_OFFERED', 422, { reason: 'PLAN_DOES_NOT_COVER_PARCEL' }, word('lnd.enforcement.problem.paymentNotOffered', { reason: word('lnd.enforcement.reason.cover') })],
    ['PAYMENT_NOT_OFFERED', 422, { reason: 'NOT_PAID_OR_DEPOSITED' }, word('lnd.enforcement.problem.paymentNotOffered', { reason: word('lnd.enforcement.reason.unpaid') })],
    ['ENFORCEMENT_CASE_EXISTS', 409, {}, word('lnd.enforcement.problem.caseExists')],
    ['SCOPE_DENIED', 403, {}, word('lnd.enforcement.problem.scopeDenied')],
    ['RESOURCE_NOT_FOUND', 404, {}, word('lnd.enforcement.problem.notFound')],
    ['VALIDATION_FAILED', 422, {}, word('lnd.enforcement.problem.validation')],
    ['INTERNAL', 500, {}, word('lnd.enforcement.problem.general')],
  ] as const)('says in words why the server refused to open a case with %s %s', async (code, status, extensions, message) => {
    open({ command: () => new ApiError({ status, code, correlationId: 'c', extensions }) });
    await fillStart();
    submit(word('lnd.enforcement.start.submit'));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('moves a case to the next step with nothing but the step, and reads the list again', async () => {
    const h = open({ cases: [enforcement(1)] });
    await openAdvance();
    expect(within(dialog()).getByTestId('current-step').textContent).toBe(word('lnd.enforcement.advance.current', { step: word('lnd.enforcement.step.persuasion') }));
    const to = within(dialog()).getByLabelText(word('lnd.enforcement.field.to.label')) as HTMLSelectElement;
    expect(Array.from(to.options).map((option) => option.value)).toEqual(['', 'NOTICE', 'SUSPENDED']);
    submit(word('lnd.enforcement.advance.submit'));
    expect(await within(dialog()).findByText(word('lnd.enforcement.field.required.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fill(word('lnd.enforcement.field.to.label'), 'NOTICE');
    expect(within(dialog()).queryByLabelText(word('lnd.enforcement.field.document.label'))).toBeNull();
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toEqual(expect.objectContaining({ name: 'advanceEnforcement', path: { id: caseId(1) }, body: { to_step: 'NOTICE' }, ifMatchVersion: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks for the document of a decision and refuses a value that is not an id, then sends it in lower case', async () => {
    const h = open({ cases: [enforcement(1, { step: 'NOTICE', allowed: { advance: true, suspend: true, next: 'ORGANIZATION_DECISION' } })] });
    await openAdvance();
    fill(word('lnd.enforcement.field.to.label'), 'ORGANIZATION_DECISION');
    submit(word('lnd.enforcement.advance.submit'));
    expect(await within(dialog()).findByText(word('lnd.enforcement.field.required.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.document.label'), 'not-an-id');
    expect(within(dialog()).getByText(word('lnd.enforcement.field.invalid.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.document.label'), ` ${DOCUMENT} `);
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]?.body).toEqual({ to_step: 'ORGANIZATION_DECISION', decision_document_version_id: DOCUMENT.toLowerCase() });
  });

  it('asks for the day planned for the execution together with the decision, and for the day it was carried out with the completion', async () => {
    const h = open({
      cases: [
        enforcement(1, { step: 'ENFORCEMENT_DECISION', allowed: { advance: true, suspend: true, next: 'EXECUTING' } }),
        enforcement(2, { step: 'EXECUTING', allowed: { advance: true, suspend: true, next: 'COMPLETED' } }),
      ],
    });
    await openAdvance('TB-1/10');
    fill(word('lnd.enforcement.field.to.label'), 'EXECUTING');
    fill(word('lnd.enforcement.field.document.label'), DOCUMENT);
    submit(word('lnd.enforcement.advance.submit'));
    expect(await within(dialog()).findByText(word('lnd.enforcement.field.required.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.planned.label'), '2026-01-01');
    expect(within(dialog()).getByText(word('lnd.enforcement.field.invalid.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.planned.label'), '2026-03-01');
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]?.body).toEqual({ to_step: 'EXECUTING', decision_document_version_id: DOCUMENT.toLowerCase(), planned_on: '2026-03-01' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openAdvance('TB-2/10');
    // The only move left is to suspend or to complete: the next step is the completion.
    fill(word('lnd.enforcement.field.to.label'), 'COMPLETED');
    submit(word('lnd.enforcement.advance.submit'));
    expect(await within(dialog()).findByText(word('lnd.enforcement.field.required.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.executed.label'), '2999-01-01');
    expect(within(dialog()).getByText(word('lnd.enforcement.field.future.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.executed.label'), '2026-01-01');
    expect(within(dialog()).getByText(word('lnd.enforcement.field.invalid.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.executed.label'), '2026-03-02');
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(sent(h)[1]?.body).toEqual({ to_step: 'COMPLETED', executed_on: '2026-03-02' });
  });

  it('asks for the reason of a suspension, and offers a suspended case the step it was suspended from or the one after it', async () => {
    const h = open({
      cases: [
        enforcement(1),
        enforcement(2, { step: 'SUSPENDED', suspended_from: 'NOTICE', suspend_reason: 'Hộ khiếu nại', allowed: { advance: true, suspend: false, next: 'NOTICE' } }),
        enforcement(3, { step: 'SUSPENDED', suspended_from: 'PERSUASION', suspend_reason: 'Chờ', allowed: { advance: true, suspend: false, next: 'NOTICE' } }),
      ],
    });
    await openAdvance('TB-1/10');
    fill(word('lnd.enforcement.field.to.label'), 'SUSPENDED');
    submit(word('lnd.enforcement.advance.submit'));
    expect(await within(dialog()).findByText(word('lnd.enforcement.field.required.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.reason.label'), 'y'.repeat(2001));
    expect(within(dialog()).getByText(word('lnd.enforcement.field.invalid.error'))).toBeTruthy();
    fill(word('lnd.enforcement.field.reason.label'), ' Hộ khiếu nại ');
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]?.body).toEqual({ to_step: 'SUSPENDED', suspend_reason: 'Hộ khiếu nại' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openAdvance('TB-2/10');
    const resume = within(dialog()).getByLabelText(word('lnd.enforcement.field.to.label')) as HTMLSelectElement;
    expect(Array.from(resume.options).map((option) => option.value)).toEqual(['', 'NOTICE', 'ORGANIZATION_DECISION']);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('lnd.enforcement.dialog.cancel') }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // A case suspended from the persuasion can only go on to the notice: the persuasion is not entered again.
    await openAdvance('TB-3/10');
    const only = within(dialog()).getByLabelText(word('lnd.enforcement.field.to.label')) as HTMLSelectElement;
    expect(Array.from(only.options).map((option) => option.value)).toEqual(['', 'NOTICE']);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('lnd.enforcement.dialog.close') }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers no move for a case that is completed, one the caller drew up, or one with nowhere to go', async () => {
    open({
      cases: [
        enforcement(1, { step: 'COMPLETED', executed_on: '2026-02-01', allowed: { advance: false, suspend: false, next: null } }),
        enforcement(2, { allowed: { advance: false, suspend: false, next: 'NOTICE' } }),
        enforcement(3, { step: 'SUSPENDED', suspended_from: null, allowed: { advance: true, suspend: false, next: null } }),
      ],
    });
    await screen.findByTestId('cases');
    expect(screen.queryAllByRole('button', { name: /^Chuyển bước hồ sơ cưỡng chế thửa/ })).toHaveLength(0);
  });

  it.each([
    ['ENFORCEMENT_STEP_INVALID', 422, word('lnd.enforcement.problem.stepInvalid')],
    ['DECISION_DOCUMENT_REQUIRED', 422, word('lnd.enforcement.problem.documentRequired')],
    ['SELF_APPROVAL_DENIED', 403, word('lnd.enforcement.problem.selfApproval')],
    ['VERSION_CONFLICT', 409, word('lnd.enforcement.problem.versionConflict')],
    ['SCOPE_DENIED', 403, word('lnd.enforcement.problem.scopeDenied')],
    ['INVALID_REQUEST', 400, word('lnd.enforcement.problem.validation')],
  ] as const)('says in words why the server refused to move a case with %s', async (code, status, message) => {
    open({ cases: [enforcement(1)], command: () => new ApiError({ status, code, correlationId: 'c' }) });
    await openAdvance();
    fill(word('lnd.enforcement.field.to.label'), 'NOTICE');
    submit(word('lnd.enforcement.advance.submit'));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
  });

  it('keeps the dialog and its refusal when the case was moved by somebody else and the list is read again, and sends the new version on the next try', async () => {
    const cases = [enforcement(1)];
    let refuse = true;
    const h = open({
      cases,
      command: () => {
        if (!refuse) return OK;
        refuse = false;
        const first = cases[0] as { version: number };
        first.version = 2;
        return new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' });
      },
    });
    await openAdvance();
    fill(word('lnd.enforcement.field.to.label'), 'NOTICE');
    submit(word('lnd.enforcement.advance.submit'));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('lnd.enforcement.problem.versionConflict'));
    await waitFor(() => expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'listEnforcementCases').length).toBeGreaterThanOrEqual(2));
    expect((within(dialog()).getByLabelText(word('lnd.enforcement.field.to.label')) as HTMLSelectElement).value).toBe('NOTICE');
    expect(within(dialog()).getByTestId('refusal')).toBeTruthy();
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(sent(h)[0]?.ifMatchVersion).toBe(1);
    expect(sent(h)[1]?.ifMatchVersion).toBe(2);
  });

  it('keeps the dialog as it was sent while the request is on its way: nothing sent twice', async () => {
    const h = open({ cases: [enforcement(1)], command: () => new Promise(() => undefined) });
    await openAdvance();
    fill(word('lnd.enforcement.field.to.label'), 'NOTICE');
    submit(word('lnd.enforcement.advance.submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: word('lnd.enforcement.dialog.pending') }).matches(':disabled')).toBe(true));
    fireEvent.submit(within(dialog()).getByLabelText(word('lnd.enforcement.field.to.label')).closest('form') as HTMLFormElement);
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the cases could not be read', async () => {
    const h = open({ failing: true });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    const asked = () => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'listEnforcementCases').length;
    await waitFor(() => expect(asked()).toBeGreaterThanOrEqual(2));
  });
});
