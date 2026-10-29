import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import DelegationScreen from './DelegationScreen';
import * as labels from './labels';
import { MAX_DAYS, barShare, daysOf, describeProblem, emptyForm, formProblems, latestEnd, offeredPermissions, readDefects, toBody, toDelegation, toLocalInput } from './model';
import type { Form, Problem } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0140'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('ADM-04', 'FR-ADM-04');
const ALL = ['iam.delegation.read', 'iam.delegation.create', 'approval.decide', 'doc.outgoing.sign', 'iam.role.grant', 'adm.workflow.manage', 'approval_task.read'];
const DAY = 86_400_000;

const delegation = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  delegator: { id: uuid(500), name: 'Lê Văn Giao' },
  delegate: { id: uuid(600 + n), name: `Người nhận ${n}` },
  permissions: ['approval.decide'],
  scope_kind: 'UNIT_SUBTREE',
  scope_ref_ids: [uuid(900)],
  valid_from: '2026-10-29T01:00:00.000000Z',
  valid_until: '2026-11-05T01:00:00.000000Z',
  reason: 'Đi công tác dài ngày.',
  legal_basis_ref: null,
  status: 'Active',
  revoked_at: null,
  revoke_reason: null,
  ended_at: null,
  end_reason: null,
  created_at: '2026-10-29T01:00:00.000000Z',
  version: 3,
  actions: { revoke: true },
  ...extra,
});
const UNITS = [
  { id: uuid(900), code: 'SO-A', name: 'Sở A' },
  { id: uuid(901), code: 'SO-B', name: 'Sở B' },
];
const MEMBERS = [
  { id: uuid(601), display_name: 'Trần Thị Nhận', status: 'Active', membership_type: 'STAFF' },
  { id: uuid(602), display_name: 'Đã nghỉ', status: 'Suspended', membership_type: 'STAFF' },
];

interface World {
  given: Array<Record<string, unknown>>;
  received: Array<Record<string, unknown>>;
  failing: boolean;
  /** The member and unit lookups of the form are refused. */
  lookupsFail?: boolean;
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}): Harness & { world: World; queries: { getQueryCache(): { getAll(): Array<{ queryKey: readonly unknown[] }> } } } {
  const world: World = { given: [], received: [], failing: false, ...state };
  const h = baseHarness(() => new Error('unexpected read'), options.command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    if (operation === 'get_resources_delegation_grant') {
      if (world.failing) return Promise.reject(new Error('failed'));
      return Promise.resolve(input?.query?.role === 'received' ? world.received : world.given);
    }
    if (world.lookupsFail && (operation === 'get_resources_organization_unit' || operation === 'get_resources_membership')) return Promise.reject(new Error('forbidden'));
    if (operation === 'get_resources_organization_unit') return Promise.resolve(UNITS);
    if (operation === 'get_resources_membership') return Promise.resolve(MEMBERS);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  const mounted = mountInSession(<DelegationScreen route={ROUTE} />, h, { permissions: options.permissions ?? ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/adm/adm-04');
  return { ...h, world, queries: mounted.queries };
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const local = (offsetDays: number): string => toLocalInput(new Date(Date.now() + offsetDays * DAY));

afterEach(() => cleanup());

describe('DelegationScreen (ADM-04): the delegations of approval authority', () => {
  it('UI-ADM-04, AC-ST-ADM-014-3: lists what the person delegated with the window, the scope, the state and a bar that never takes more than the 90 days', async () => {
    open({
      given: [
        delegation(1),
        delegation(2, { valid_from: '2026-10-01T00:00:00.000000Z', valid_until: '2027-03-01T00:00:00.000000Z', status: 'Scheduled' }),
        delegation(3, { status: 'Ended', end_reason: 'SOURCE_ENDED', actions: { revoke: false } }),
        delegation(4, { status: 'Revoked', revoke_reason: 'Quay lại sớm.', actions: { revoke: false } }),
      ],
    });
    await screen.findByTestId('delegations');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.delegation.title'));
    const row = (n: number) => document.querySelector(`[data-delegation="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('adm.delegation.status.active'));
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('adm.delegation.status.scheduled'));
    expect(row(1).textContent).toContain('Người nhận 1');
    expect(row(1).textContent).toContain('approval.decide');
    expect(row(1).textContent).toContain(word('adm.delegation.scope.subtree'));
    expect(row(1).textContent).toContain('Sở A');
    expect(row(3).textContent).toContain(word('adm.delegation.end.source'));
    expect(row(4).textContent).toContain('Quay lại sớm.');
    // The bar: a week fills a part of it, and a window longer than 90 days (it cannot be made, but a row could say so) fills the bar and no more.
    const bars = Array.from(document.querySelectorAll('[role="progressbar"]')) as HTMLElement[];
    expect(bars.length).toBe(4);
    for (const bar of bars) {
      expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(MAX_DAYS);
      expect(Number(bar.getAttribute('aria-valuemax'))).toBe(MAX_DAYS);
      expect(parseFloat((bar.firstElementChild as HTMLElement).style.width)).toBeLessThanOrEqual(100);
    }
    expect(row(1).querySelector('[role="progressbar"]')?.getAttribute('data-days')).toBe('7');
    expect(row(2).querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('90');
    expect((row(2).querySelector('[role="progressbar"]')?.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('shows what was delegated to the person in the other tab, with the name of the delegator, and nothing to revoke', async () => {
    open({ given: [delegation(1)], received: [delegation(7, { actions: { revoke: false } })] });
    await screen.findByTestId('delegations');
    fireEvent.click(document.querySelector('[data-tab="received"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector(`[data-delegation="${uuid(7)}"]`)).not.toBeNull());
    expect(document.querySelector(`[data-delegation="${uuid(1)}"]`)).toBeNull();
    expect((document.querySelector(`[data-delegation="${uuid(7)}"]`) as HTMLElement).textContent).toContain('Lê Văn Giao');
    expect(document.querySelector('[data-action="revoke"]')).toBeNull();
  });

  it('delegates with the permissions the person holds (never the administration), the scope, the dates and a reason, and sends what the form says', async () => {
    const h = open({}, { command: () => ({ resource_id: uuid(50), resource_version: 1 }) });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    // The permissions offered are the person's own business permissions: no iam.*, adm.*, nor the reads.
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Trần Thị Nhận' })).toBeTruthy());
    expect(within(dialog()).queryByRole('option', { name: 'Đã nghỉ' })).toBeNull();
    expect(
      within(dialog())
        .getAllByRole('checkbox')
        .map((box) => (box as HTMLInputElement).value),
    ).toEqual(['approval.decide', 'doc.outgoing.sign']);
    // Nothing is sent while the form is not whole.
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.new.submit') }));
    for (const key of ['delegate', 'permissions', 'unit', 'reason']) expect(within(dialog()).getByText(word(`adm.delegation.problem.${key}`))).toBeTruthy();
    expect(commandsCalled(h, 'createDelegation')).toHaveLength(0);
    type('delegation-delegate', uuid(601));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'approval.decide' }));
    type('delegation-unit', uuid(900));
    type('delegation-reason', 'Đi công tác dài ngày, ủy quyền duyệt hồ sơ.');
    type('delegation-basis', 'QĐ 12/QĐ-UBND');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.new.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [sent] = commandsCalled(h, 'createDelegation');
    expect(sent?.body).toMatchObject({ delegate_membership_id: uuid(601), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [uuid(900)], reason: 'Đi công tác dài ngày, ủy quyền duyệt hồ sơ.', legal_basis_ref: 'QĐ 12/QĐ-UBND' });
    const days = (Date.parse(sent?.body?.valid_until as string) - Date.parse(sent?.body?.valid_from as string)) / DAY;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('AC-ST-ADM-014-3: the end field cannot go past 90 days of the start, the bar follows the dates and says so, and a longer window is not sent', async () => {
    const h = open();
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    const until = document.getElementById('delegation-until') as HTMLInputElement;
    const from = document.getElementById('delegation-from') as HTMLInputElement;
    expect(until.max).toBe(latestEnd(from.value));
    expect(Date.parse(until.max) - Date.parse(from.value)).toBe(MAX_DAYS * DAY);
    expect(screen.getByTestId('bar-note').textContent).toBe(word('adm.delegation.bar.note').replace('{days}', '7').replace('{max}', '90'));
    type('delegation-until', local(60));
    expect(screen.getByTestId('bar-note').textContent).toContain('60');
    expect(Number((dialog().querySelector('[role="progressbar"]') as HTMLElement).getAttribute('aria-valuenow'))).toBeLessThanOrEqual(MAX_DAYS);
    // A window of 95 days: the bar is full and no more, the field says why, nothing is sent.
    type('delegation-until', local(95));
    expect(Number((dialog().querySelector('[role="progressbar"]') as HTMLElement).getAttribute('aria-valuenow'))).toBe(MAX_DAYS === 90 ? 90 : MAX_DAYS);
    expect((dialog().querySelector('.delegation-bar-fill') as HTMLElement).style.width).toBe('100%');
    type('delegation-delegate', uuid(601));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'approval.decide' }));
    type('delegation-unit', uuid(900));
    type('delegation-reason', 'Đi công tác dài ngày, ủy quyền duyệt hồ sơ.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.new.submit') }));
    expect(within(dialog()).getByText(word('adm.delegation.problem.tooLong'))).toBeTruthy();
    expect(commandsCalled(h, 'createDelegation')).toHaveLength(0);
  });

  it('says why the server refused: a delegation of what is delegated (no chain), more than the person holds, the defects of a request, and keeps the form', async () => {
    let answer: unknown = problem('DELEGATION_CHAIN_DENIED', 403);
    const h = open({}, { command: () => answer });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Trần Thị Nhận' })).toBeTruthy());
    type('delegation-delegate', uuid(601));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'approval.decide' }));
    type('delegation-unit', uuid(900));
    type('delegation-reason', 'Đi công tác dài ngày, ủy quyền duyệt hồ sơ.');
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.new.submit') }));
    };
    send();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.delegation.error.chain'));
    answer = problem('ROLE_ESCALATION_DENIED', 403);
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.delegation.error.escalation')));
    answer = problem('DELEGATION_INVALID', 422, {
      defects: [
        { field: 'permissions[1]', code: 'ADMINISTRATIVE' },
        { field: 'valid_until', code: 'TOO_LONG' },
      ],
    });
    send();
    await waitFor(() => expect(screen.getByTestId('defects')).toBeTruthy());
    expect(Array.from(document.querySelectorAll('[data-testid="defects"] [data-field]')).map((item) => [item.getAttribute('data-field'), item.textContent])).toEqual([
      ['permissions[1]', `permissions[1] ${word('adm.delegation.defect.administrative')}`],
      ['valid_until', `valid_until ${word('adm.delegation.defect.tooLong')}`],
    ]);
    expect((document.getElementById('delegation-reason') as HTMLTextAreaElement).value).toBe('Đi công tác dài ngày, ủy quyền duyệt hồ sơ.');
    expect(commandsCalled(h, 'createDelegation').length).toBe(3);
  });

  it('revokes a delegation with a reason, at the version that was read, and says why when it cannot', async () => {
    let answer: unknown = problem('DELEGATION_STATE_INVALID', 409);
    const h = open({ given: [delegation(1)] }, { command: () => answer });
    await screen.findByTestId('delegations');
    fireEvent.click(document.querySelector('[data-action="revoke"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.revoke.submit') }));
    expect(within(dialog()).getByText(word('adm.delegation.problem.reason'))).toBeTruthy();
    expect(commandsCalled(h, 'revokeDelegation')).toHaveLength(0);
    type('revoke-reason', 'Quay lại làm việc sớm hơn dự kiến.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.revoke.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.delegation.error.notRevocable'));
    answer = { resource_id: uuid(1), resource_version: 4 };
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.delegation.revoke.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'revokeDelegation')[1]).toMatchObject({ path: { delegationId: uuid(1) }, body: { reason: 'Quay lại làm việc sớm hơn dự kiến.' }, ifMatchVersion: 3 });
  });

  it('offers what the person may do: no new delegation without the right to create, nothing to change while read-only, and a denied screen without the right to read', async () => {
    open({ given: [delegation(1)] }, { permissions: ['iam.delegation.read'] });
    await screen.findByTestId('delegations');
    expect(document.querySelector('[data-action="new"]')).toBeNull();
    cleanup();
    open({ given: [delegation(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('delegations');
    expect(document.querySelector('[data-action="new"], [data-action="revoke"]')).toBeNull();
    cleanup();
    const denied = open({ given: [delegation(1)] }, { permissions: ['iam.delegation.create'] });
    await waitFor(() => expect(screen.queryByTestId('delegations')).toBeNull());
    expect(denied.client.readAll).not.toHaveBeenCalled();
  });

  it('says so when the delegates and the units cannot be listed (the account lacks the directory rights), instead of leaving the selectors empty', async () => {
    open({ lookupsFail: true });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    expect((await screen.findByTestId('lookup-failed')).textContent).toBe(word('adm.delegation.form.lookupFailed'));
  });

  it('shows the states: nothing delegated yet, and a read that failed with a way to read again', async () => {
    const empty = open();
    await waitFor(() => expect(empty.client.readAll).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('delegations')).toBeNull();
    cleanup();
    const failing = open({ failing: true });
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.world.failing = false;
    failing.world.given = [delegation(1)];
    fireEvent.click(retry);
    await screen.findByTestId('delegations');
  });
  it('reads the directory in the scope of the membership that is signed in: its query is keyed by the tenant and the membership, so switching memberships never shows the other directory', async () => {
    const h = open({ given: [delegation(1)] });
    await screen.findByTestId('delegations');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() =>
      expect(
        h.queries
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey.includes('delegates')),
      ).toBe(true),
    );
    const key =
      h.queries
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey.includes('delegates'))?.queryKey ?? [];
    expect(key.slice(0, 2)).toEqual(['adm', 'delegations']);
    expect(typeof key[2]).toBe('string');
    expect(typeof key[3]).toBe('string');
  });
});

describe('the model of the delegation screen', () => {
  const NOW = new Date('2026-10-29T03:00:00Z');
  const whole = (extra: Partial<Form> = {}): Form => ({ ...emptyForm(NOW), delegateId: uuid(1), permissions: ['approval.decide'], unitId: uuid(900), reason: 'Đi công tác dài ngày.', ...extra });

  it('measures a window in days and never fills more than the whole bar', () => {
    expect(daysOf('2026-10-29T00:00:00Z', '2026-11-05T00:00:00Z')).toBe(7);
    expect(daysOf('2026-11-05T00:00:00Z', '2026-10-29T00:00:00Z')).toBe(0);
    expect(daysOf('nonsense', '2026-10-29T00:00:00Z')).toBe(0);
    expect(barShare('2026-10-29T00:00:00Z', '2026-11-05T00:00:00Z')).toBeCloseTo(7 / 90, 5);
    expect(barShare('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toBe(1);
    expect(latestEnd('nonsense')).toBe('');
  });

  it('finds what needs no server: a missing delegate, permission or unit, dates that do not run forward, more than 90 days, a start in the past, a short reason', () => {
    expect(formProblems(whole(), NOW)).toEqual([]);
    expect(formProblems(emptyForm(NOW), NOW)).toEqual(['delegateRequired', 'permissionsRequired', 'unitRequired', 'reasonShort']);
    expect(formProblems(whole({ validUntil: whole().validFrom }), NOW)).toEqual(['datesInvalid']);
    expect(formProblems(whole({ validUntil: toLocalInput(new Date(Date.parse(toLocalInput(NOW)) + 91 * DAY)) }), NOW)).toEqual(['tooLong']);
    expect(formProblems(whole({ validUntil: toLocalInput(new Date(Date.parse(toLocalInput(NOW)) + 90 * DAY)) }), NOW)).toEqual([]);
    expect(formProblems(whole({ validFrom: toLocalInput(new Date(NOW.getTime() - 3 * DAY)), validUntil: toLocalInput(new Date(NOW.getTime() + DAY)) }), NOW)).toEqual(['inThePast']);
    expect(formProblems(whole({ reason: 'ngắn' }), NOW)).toEqual(['reasonShort']);
  });

  it('builds the body the server takes, with the legal basis only when it is given', () => {
    const body = toBody(whole({ legalBasis: ' ' }));
    expect(body).toMatchObject({ delegate_membership_id: uuid(1), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [uuid(900)] });
    expect('legal_basis_ref' in body).toBe(false);
    expect(toBody(whole({ legalBasis: 'QĐ 12' })).legal_basis_ref).toBe('QĐ 12');
  });

  it('offers the business permissions the person holds, and suggestions when the session does not list them', () => {
    expect(offeredPermissions(['approval.decide', 'iam.role.grant', 'adm.doa.manage', 'system.tenant.manage', 'workflow_version.read', '*', 'payment.approve', 'approval.decide', 'doc.outgoing.sign'])).toEqual(['approval.decide', 'doc.outgoing.sign']);
    expect(offeredPermissions(undefined)).toEqual(['approval.decide', 'doc.outgoing.sign']);
    expect(offeredPermissions([])).toEqual([]);
  });

  it('reads a delegation and leaves out a row that is not one', () => {
    expect(toDelegation(delegation(1))).toMatchObject({ id: uuid(1), delegateName: 'Người nhận 1', delegatorName: 'Lê Văn Giao', status: 'Active', version: 3, mayRevoke: true, permissions: ['approval.decide'] });
    expect(toDelegation({ ...delegation(1), status: 'Gone' })).toBeUndefined();
    expect(toDelegation({ ...delegation(1), delegate: {} })).toBeUndefined();
    expect(toDelegation(null)).toBeUndefined();
    expect(toDelegation({ ...delegation(1), actions: {} })?.mayRevoke).toBe(false);
  });

  it('names each refusal, reads the defects of a refused request and has a word for every one', () => {
    const cases: Array<[string, Problem]> = [
      ['DELEGATION_CHAIN_DENIED', 'chain'],
      ['ROLE_ESCALATION_DENIED', 'escalation'],
      ['SELF_GRANT_DENIED', 'self'],
      ['DELEGATION_INVALID', 'invalid'],
      ['VALIDATION_FAILED', 'invalid'],
      ['MEMBERSHIP_INACTIVE', 'inactive'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['DELEGATION_STATE_INVALID', 'notRevocable'],
      ['SCOPE_DENIED', 'denied'],
      ['OTHER', 'general'],
    ];
    for (const [code, expected] of cases) expect(describeProblem(problem(code))).toBe(expected);
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(readDefects(problem('DELEGATION_INVALID', 422, { defects: [{ field: 'valid_until', code: 'TOO_LONG' }, { bad: true }] }))).toEqual([{ field: 'valid_until', code: 'TOO_LONG' }]);
    expect(readDefects(problem('OTHER', 422, { defects: [{ field: 'x', code: 'y' }] }))).toEqual([]);
    const t = ((key: string) => word(key)) as Parameters<typeof labels.problemMessage>[0];
    for (const kind of ['chain', 'escalation', 'self', 'invalid', 'inactive', 'notFound', 'versionConflict', 'notRevocable', 'denied', 'general'] as const) expect(labels.problemMessage(t, kind)).not.toMatch(/^adm\.delegation\./);
    for (const code of ['TOO_LONG', 'BEFORE_START', 'IN_THE_PAST', 'ALREADY_ENDED', 'ADMINISTRATIVE', 'WILDCARD', 'DUPLICATE', 'REQUIRED', 'MALFORMED', 'UNSUPPORTED']) expect(labels.defectLabel(t, code)).not.toMatch(/^adm\.delegation\./);
    expect(labels.defectLabel(t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    for (const kind of ['delegateRequired', 'permissionsRequired', 'unitRequired', 'datesInvalid', 'tooLong', 'inThePast', 'reasonShort'] as const) expect(labels.formProblemMessage(t, kind)).not.toMatch(/^adm\.delegation\./);
    expect(labels.scopeKindLabel(t, 'PROJECT')).toBe(word('adm.delegation.scope.project'));
    expect(labels.scopeKindLabel(t, 'OTHER')).toBe('OTHER');
    expect(labels.endReasonLabel(t, null)).toBe('');
  });
});
