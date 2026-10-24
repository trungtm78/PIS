import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { PolicyTable } from './PolicyTable';
import { groupPolicies, toPolicy, toUnit } from './model';
import type { PolicyView } from './model';
import { MANAGER, client, mount, policy, unit, world } from './test-support';

const TODAY = '2026-08-01';
const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const views = (rows: Array<Record<string, unknown>>): PolicyView[] => rows.flatMap((row) => toPolicy(row) ?? []);
const UNITS = new Map([[unit(1).id, toUnit(unit(1))!]]);

afterEach(cleanup);

const table = (rows: Array<Record<string, unknown>>, mayRetire = true) => <PolicyTable groups={groupPolicies(views(rows), TODAY)} units={UNITS} today={TODAY} mayRetire={mayRetire} />;
const groupRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-group-key]'));
const cells = (row: HTMLElement): Array<string | null> => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent);

const POLICIES = [
  policy(1),
  policy(2, { severity: 'LOW', owner_unit_id: unit(1).id, response_hours: 8, resolve_hours: 24, escalate_l2_pct: 80, escalate_l3_pct: 120, valid_from: '2026-09-01', code: 'SLA-LOW' }),
  policy(3, { status: 'RETIRED', valid_until: '2026-07-01' }),
];

describe('PolicyTable (ISS-09): the SLA policies by category, severity and unit', () => {
  it('shows each category, severity and unit once, with the hours, the thresholds, the validity and the phase of the version that matters now', () => {
    mount(table(POLICIES), client(world()), MANAGER);
    expect(screen.getByRole('table', { name: vi_['iss.sla.table.aria'] })).toBeTruthy();
    expect(groupRows().map((row) => row.getAttribute('data-severity'))).toEqual(['HIGH', 'LOW', 'HIGH']);
    const [first, second, third] = groupRows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(cells(first).slice(0, 9)).toEqual([
      'GPMB-1 Giải phóng mặt bằng 1',
      vi_['iss.severity.high.text'],
      vi_['iss.sla.unit.default.text'],
      'WORKDAY_VN',
      '4',
      '72',
      'Cấp 2: 100% · Cấp 3: 150%',
      '2026-01-01 → ',
      vi_['iss.sla.phase.inForce.text'],
    ]);
    // A version that has not begun is scheduled, and a unit is shown by its name.
    expect(cells(second).slice(2, 3)).toEqual([unit(1).name]);
    expect(cells(second)[7]).toBe('2026-09-01 → ');
    expect(second.getAttribute('data-phase')).toBe('scheduled');
    expect(cells(second)[8]).toBe(vi_['iss.sla.phase.scheduled.text']);
    // A version that ended is shown with its end date.
    expect(third.getAttribute('data-phase')).toBe('ended');
    expect(cells(third)[7]).toBe('2026-01-01 → 2026-07-01');
  });

  it('keeps the versions of a policy together and lists every one of them in the history, newest first (AC-ST-ISS-001-2)', async () => {
    const rows = [
      policy(1, { id: 'old', code: 'SLA-GPMB', revision: 1, resolve_hours: 72, valid_from: '2026-01-01', valid_until: '2026-09-01', status: 'RETIRED' }),
      policy(1, { id: 'new', code: 'SLA-GPMB', revision: 2, resolve_hours: 48, valid_from: '2026-09-01' }),
    ];
    mount(table(rows), client(world()), MANAGER);
    expect(groupRows()).toHaveLength(1);
    // The version in force today is the first one; the second is waiting for its date.
    expect(groupRows()[0]?.getAttribute('data-policy-id')).toBe('old');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['iss.sla.history.action'] }));
    const history = screen.getByTestId('history');
    expect(within(history).getByRole('table', { name: vi_['iss.sla.history.aria'] })).toBeTruthy();
    const versions = Array.from(history.querySelectorAll<HTMLElement>('tr[data-revision]'));
    expect(versions.map((row) => row.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(cells(versions[0] as HTMLElement)).toEqual(['2', 'SLA-GPMB', '4', '48', 'Cấp 2: 100% · Cấp 3: 150%', `${vi_['iss.sla.rules.verifier.text']} · ${vi_['iss.sla.rules.evidence.text']}`, '2026-09-01 → ', vi_['iss.sla.phase.scheduled.text']]);
    expect(cells(versions[1] as HTMLElement)[3]).toBe('72');
    await user.click(screen.getByRole('button', { name: vi_['iss.sla.history.action'] }));
    expect(screen.queryByTestId('history')).toBeNull();
  });

  it('names the rules of closing only when they are on', async () => {
    mount(table([policy(1, { require_evidence: false, require_independent_verifier: false })]), client(world()), MANAGER);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['iss.sla.history.action'] }));
    const row = document.querySelector('tr[data-revision]') as HTMLElement;
    expect(cells(row)[5]).toBe('');
  });

  it('shows a unit that is not in the list by its id rather than hiding it', () => {
    mount(table([policy(1, { owner_unit_id: '00000000-0000-4000-8000-0000000000ff' })]), client(world()), MANAGER);
    expect(cells(groupRows()[0] as HTMLElement)[2]).toBe('00000000-0000-4000-8000-0000000000ff');
  });
});

describe('PolicyTable: ending a policy', () => {
  const retireButton = (code: string): HTMLElement => within(document.querySelector(`tr[data-policy-id="${code}"]`) as HTMLElement).getByRole('button', { name: vi_['iss.sla.retire.action'] });
  const formName = (code: string): string => vi_['iss.sla.retire.title'].replace('{code}', code);

  it('asks for an end date, then ends the policy from it (AC-ST-ISS-001-2)', async () => {
    const h = client(world(), () => ({ operation_id: 'o', status: 'RETIRED', resource_version: 2, resource_id: policy(1).id }));
    mount(table([policy(1)]), h, MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(policy(1).id));
    const form = screen.getByRole('form', { name: formName('SLA-1') });
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['iss.field.required.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['iss.sla.retire.until.label']), { target: { value: '2026-07-01' } });
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['iss.field.past.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['iss.sla.retire.until.label']), { target: { value: '2026-12-31' } });
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.retire.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('retireIssueSlaPolicy', expect.objectContaining({ path: { id: policy(1).id }, body: { valid_until: '2026-12-31' } })));
    await waitFor(() => expect(screen.queryByRole('form', { name: formName('SLA-1') })).toBeNull());
  });

  it('refuses an end date that is not after the start of the policy, before asking the server', async () => {
    const h = client(world());
    mount(table([policy(1, { valid_from: '2026-09-10' })]), h, MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(policy(1).id));
    const form = screen.getByRole('form', { name: formName('SLA-1') });
    fireEvent.change(within(form).getByLabelText(vi_['iss.sla.retire.until.label']), { target: { value: '2026-09-10' } });
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['iss.field.untilOrder.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['iss.sla.retire.until.label']), { target: { value: 'soon' } });
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.retire.confirm.action'] }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the refusal of the server and lets the person cancel', async () => {
    const h = client(world(), () => problem('SLA_POLICY_STATE_INVALID'));
    mount(table([policy(1)]), h, MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(policy(1).id));
    const form = screen.getByRole('form', { name: formName('SLA-1') });
    fireEvent.change(within(form).getByLabelText(vi_['iss.sla.retire.until.label']), { target: { value: '2026-12-31' } });
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.retire.confirm.action'] }));
    expect((await within(form).findByRole('alert')).textContent).toBe(vi_['iss.problem.stateInvalid.error']);
    await user.click(within(form).getByRole('button', { name: vi_['iss.sla.cancel.action'] }));
    expect(screen.queryByRole('form', { name: formName('SLA-1') })).toBeNull();
  });

  it('closes the form when the same button is pressed again, and offers nothing to end where there is nothing to end or no right to do it', async () => {
    mount(table([policy(1), policy(2, { severity: 'LOW', status: 'RETIRED', valid_until: '2026-12-01' })]), client(world()), MANAGER);
    const user = userEvent.setup();
    await user.click(retireButton(policy(1).id));
    expect(screen.getByRole('form', { name: formName('SLA-1') })).toBeTruthy();
    await user.click(retireButton(policy(1).id));
    expect(screen.queryByRole('form', { name: formName('SLA-1') })).toBeNull();
    // A policy that already has an end date cannot be ended again.
    expect(within(document.querySelector(`tr[data-policy-id="${policy(2).id}"]`) as HTMLElement).queryByRole('button', { name: vi_['iss.sla.retire.action'] })).toBeNull();
    cleanup();
    mount(table([policy(1)], false), client(world()), MANAGER);
    expect(screen.queryByRole('button', { name: vi_['iss.sla.retire.action'] })).toBeNull();
    expect(screen.getByRole('button', { name: vi_['iss.sla.history.action'] })).toBeTruthy();
  });
});
