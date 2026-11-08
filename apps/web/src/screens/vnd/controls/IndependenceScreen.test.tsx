import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import IndependenceScreen from './IndependenceScreen';
import { AS_OF, client, mount, policy, routeOf, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const route = routeOf('VND-07', 'FR-VND-07');
const PACKAGE = uuid('0030', 1);
const CONTRACTOR_A = uuid('0001', 1);
const CONTRACTOR_B = uuid('0001', 2);
const MEMBER = uuid('0020', 1);
const ADMIN = ['vnd.read', 'vnd.independence.read', 'vnd.interest.declare', 'vnd.independence.run', 'vnd.independence.decide', 'vnd.package.controls'];

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(new RegExp(escaped(label))), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });

const finding = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0040', n),
  check_id: uuid('0041', 1),
  fingerprint: `BIDDERS_SHARE_REPRESENTATIVE|CONTRACTOR:a|CONTRACTOR:b${n}`,
  kind: 'BIDDERS_SHARE_REPRESENTATIVE',
  strength: 'STRONG',
  parties: [
    { kind: 'CONTRACTOR', id: CONTRACTOR_A, name: 'Công ty A' },
    { kind: 'CONTRACTOR', id: CONTRACTOR_B, name: 'Công ty B' },
  ],
  evidence: {},
  raised_by: uuid('0020', 9),
  carried_from_id: null,
  decision: null,
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  allowed_decisions: ['CLEARED', 'BLOCKED'],
  can_decide: true,
  version: 1,
  ...over,
});

const check = {
  id: uuid('0041', 1),
  run_by: uuid('0020', 9),
  run_at: '2026-11-07T03:00:00.000Z',
  rule_version: 'builtin',
  rule_unverified: true,
  inputs_digest: 'a'.repeat(64),
  panel_ids: [],
  staff_ids: [],
  owner_tax_head: null,
  bidders_count: 2,
  findings_count: 2,
  strong_count: 1,
};

const view = (over: Record<string, unknown> = {}) => ({
  package_id: PACKAGE,
  check,
  findings: [finding(1), finding(2, { kind: 'BIDDERS_SHARE_ADDRESS', strength: 'MEDIUM', allowed_decisions: ['CLEARED', 'BLOCKED'] })],
  gate: { checked: true, open: false, blocked: 0, undecided_strong: 1, undecided: 2, cleared: 0, recused: 0 },
  policy: policy('VENDOR_INDEPENDENCE'),
  as_of: AS_OF,
  ...over,
});

const controls = (over: Record<string, unknown> = {}) => ({ package_id: PACKAGE, security_base_amount: 50000, bid_valid_until: '2026-12-31', estimated_value: null, duration_months: 12, budget_vnd: 1200000, version: 3, ...over });
const interest = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0050', n),
  membership_id: MEMBER,
  member_name: 'Lê Thị Hoa',
  kind: 'RELATIVE',
  related_name: 'Lê Văn Bảo',
  relation: 'anh',
  has_related_identity: true,
  contractor_id: null,
  contractor_name: null,
  tax_head: null,
  share_pct: null,
  since_on: '2026-10-01',
  ended_on: null,
  ended_reason: null,
  document_id: null,
  created_by: MEMBER,
  version: 1,
  ...over,
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  answers?: Record<string, unknown>;
  failing?: World['failing'];
}

function open(options: Options = {}) {
  const world: World = {
    answers: { getVendorIndependence: view(), getVendorPackageControls: controls(), listVendorPersonInterests: { items: [interest(1)], as_of: AS_OF }, ...options.answers },
    ...(options.failing === undefined ? {} : { failing: options.failing }),
  };
  const h = client(world);
  mount(<IndependenceScreen route={route} />, h, { permissions: options.permissions ?? ADMIN, path: options.path ?? `/vnd/vnd-07?package=${PACKAGE}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-finding-id]'));
const loaded = async (): Promise<void> => {
  await screen.findAllByText(word('vnd.controls.kind.biddersShareRepresentative.name'));
};

describe('IndependenceScreen (VND-07): the independence of the bidders of a package', () => {
  it('asks for a package when the address names none, and keeps the button off until the identifier is one', () => {
    open({ path: '/vnd/vnd-07' });
    const picker = screen.getByTestId('package-picker');
    const button = within(picker).getByRole('button', { name: word('vnd.controls.pick.action') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(picker).getByLabelText(word('vnd.controls.pick.label')), { target: { value: PACKAGE } });
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId('pick-empty').textContent).toBe(word('vnd.controls.pick.empty.text'));
  });

  it('shows a closed gate with its counts, each with the "i", and the summary of the check with the rule flagged unverified', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('getVendorIndependence', { path: { id: PACKAGE } });
    const banner = screen.getByTestId('gate-banner');
    expect(banner.textContent).toContain(word('vnd.controls.gate.closed'));
    expect(screen.getByTestId('gate-undecided-strong').textContent).toContain('1');
    expect(screen.getByTestId('gate-undecided').textContent).toContain('2');
    fireEvent.click(within(screen.getByTestId('gate-blocked')).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.controls.gate.blocked') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.controls.gate.blocked') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe(word('vnd.controls.gate.formula.text'));
    expect(screen.getByTestId('check-summary').textContent).toContain(text('vnd.controls.check.summary.text', { time: '07/11/2026 10:00', bidders: 2, findings: 2, strong: 1, version: 'builtin' }));
    expect(within(banner).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.controls.figure.gate.name') }) })).toBeTruthy();
  });

  it('lists the findings with the kind, the strength, the parties linked to their finance, and says a package never checked is not blocked', async () => {
    open();
    await loaded();
    const [first, second] = rows();
    expect(first?.textContent).toContain(word('vnd.controls.strength.strong.name'));
    expect(first?.textContent).toContain(word('vnd.controls.decision.none.name'));
    expect(within(first as HTMLElement).getByRole('link', { name: 'Công ty A' }).getAttribute('href')).toBe(`/vnd/vnd-08?contractor=${CONTRACTOR_A}&package=${PACKAGE}`);
    expect(second?.textContent).toContain(word('vnd.controls.kind.biddersShareAddress.name'));
    expect(second?.textContent).toContain(word('vnd.controls.strength.medium.name'));
    cleanup();
    open({ answers: { getVendorIndependence: view({ check: null, findings: [], gate: { checked: false, open: true, blocked: 0, undecided_strong: 0, undecided: 0, cleared: 0, recused: 0 } }) } });
    expect((await screen.findByTestId('findings-empty')).textContent).toBe(word('vnd.controls.findings.never.text'));
    expect(screen.getByTestId('gate-banner').textContent).toContain(word('vnd.controls.gate.never'));
  });

  it('shows a decided finding with the decision, the reason and the time, and offers no decision on it', async () => {
    open({ answers: { getVendorIndependence: view({ findings: [finding(1, { decision: 'BLOCKED', decided_by: uuid('0020', 2), decided_at: '2026-11-07T04:00:00.000Z', decision_reason: 'Cùng một người đại diện trên hai đăng ký', can_decide: false })] }) } });
    await loaded();
    const [row] = rows();
    expect(row?.textContent).toContain(word('vnd.controls.decision.blocked.name'));
    expect(row?.textContent).toContain('Cùng một người đại diện trên hai đăng ký');
    expect(within(row as HTMLElement).queryByTestId('decide-finding')).toBeNull();
  });

  it('decides a finding with the decisions that fit it, a reason of 20 characters and the version it saw', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('decide-finding'));
    const form = dialog(word('vnd.controls.decide.title'));
    const send = within(form).getByRole('button', { name: word('vnd.controls.decide.confirm') }) as HTMLButtonElement;
    const select = within(form).getByLabelText(new RegExp(escaped(word('vnd.controls.decide.decision.label')))) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value).filter((value) => value !== '')).toEqual(['CLEARED', 'BLOCKED']);
    expect(send.disabled).toBe(true);
    type(form, word('vnd.controls.decide.decision.label'), 'BLOCKED');
    type(form, word('vnd.field.reason.label'), 'ngắn');
    expect(send.disabled).toBe(true);
    type(form, word('vnd.field.reason.label'), 'Cùng một người đại diện trên hai đăng ký');
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('decideVendorIndependenceFinding', { path: { id: uuid('0040', 1) }, ifMatchVersion: 1, body: { decision: 'BLOCKED', reason: 'Cùng một người đại diện trên hai đăng ký' }, attempt: { key: expect.any(String) } }),
    );
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.controls.decide.title'));
  });

  it('runs the check with the lists of members and refuses a list that holds something that is not an identifier', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(screen.getByTestId('run-check'));
    const form = dialog(word('vnd.controls.run.title'));
    const send = within(form).getByRole('button', { name: word('vnd.controls.run.confirm') }) as HTMLButtonElement;
    type(form, word('vnd.controls.run.panel.label'), 'khong-phai-ma');
    expect(send.disabled).toBe(true);
    type(form, word('vnd.controls.run.panel.label'), `${MEMBER}, ${uuid('0020', 2)}`);
    type(form, word('vnd.controls.run.owner.label'), '0101234567');
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('runVendorIndependenceCheck', { path: { id: PACKAGE }, body: { panel_membership_ids: [MEMBER, uuid('0020', 2)], staff_membership_ids: [], owner_tax_code: '0101234567' }, attempt: { key: expect.any(String) } }),
    );
  });

  it('sets the controls of the package, sending null for what was emptied', async () => {
    const { h } = open();
    await loaded();
    expect(screen.getByTestId('package-controls').textContent).toContain('50.000');
    fireEvent.click(screen.getByTestId('set-controls'));
    const form = dialog(word('vnd.controls.package.title'));
    type(form, word('vnd.controls.package.security.label'), '60000');
    type(form, word('vnd.controls.package.valid.label'), '');
    type(form, word('vnd.controls.package.months.label'), '');
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.controls.package.confirm') }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('setVendorPackageControls', { path: { id: PACKAGE }, ifMatchVersion: 3, body: { security_base_amount: 60000, bid_valid_until: null, estimated_value: null, duration_months: null }, attempt: { key: expect.any(String) } }),
    );
  });

  it('declares an interest of a relative and ends one', async () => {
    const { h } = open();
    await loaded();
    expect(document.querySelector('tr[data-interest-id]')?.textContent).toContain('Lê Thị Hoa');
    fireEvent.click(screen.getByTestId('declare-interest'));
    const form = dialog(word('vnd.controls.interest.title'));
    type(form, word('vnd.controls.interest.kind.label'), 'RELATIVE');
    type(form, word('vnd.controls.interest.relative.label'), 'Lê Văn Bảo');
    type(form, word('vnd.controls.interest.identity.label'), '079123456789');
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.controls.interest.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('declareVendorPersonInterest', { body: { kind: 'RELATIVE', related_name: 'Lê Văn Bảo', related_identity_number: '079123456789' }, attempt: { key: expect.any(String) } }));
    await screen.findByTestId('receipt');
    fireEvent.click(screen.getByTestId('end-interest'));
    const ending = dialog(word('vnd.controls.interest.end.title'));
    type(ending, word('vnd.field.reason.label'), 'Người thân đã rời công ty');
    fireEvent.click(within(ending).getByRole('button', { name: word('vnd.controls.interest.end.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('endVendorPersonInterest', { path: { id: uuid('0050', 1) }, ifMatchVersion: 1, body: { reason: 'Người thân đã rời công ty' }, attempt: { key: expect.any(String) } }));
  });

  it('hides every action in a read-only workspace and for a caller without the rights, and still shows the data', async () => {
    open({ mode: 'READ_ONLY' });
    await loaded();
    for (const id of ['run-check', 'declare-interest', 'set-controls', 'decide-finding', 'end-interest']) expect(screen.queryAllByTestId(id)).toHaveLength(0);
    cleanup();
    open({ permissions: ['vnd.read', 'vnd.independence.read'] });
    await loaded();
    for (const id of ['run-check', 'declare-interest', 'set-controls']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('says a package that is not found, and an error with a retry that reads again', async () => {
    open({ failing: { getVendorIndependence: { error: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }), times: 5 } } });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open({ failing: { getVendorIndependence: { error: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }), times: 1 } } });
    const retry = await screen.findByRole('button', { name: word('states.retry.action') });
    fireEvent.click(retry);
    await loaded();
  });

  it('says in place that the declarations or the controls could not be read, without hiding the findings', async () => {
    open({ failing: { listVendorPersonInterests: { error: new Error('down'), times: 5 }, getVendorPackageControls: { error: new Error('down'), times: 5 } } });
    await loaded();
    expect(await screen.findByTestId('interests-failed')).toBeTruthy();
    expect(await screen.findByTestId('controls-failed')).toBeTruthy();
  });
});
