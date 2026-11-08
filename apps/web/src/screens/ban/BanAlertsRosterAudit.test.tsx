import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as word, translator } from '../../i18n';
import AlertsScreen from './AlertsScreen';
import RosterScreen from './RosterScreen';
import ViewAuditScreen from './ViewAuditScreen';
import { AUDITOR, HEAD, READER, SECRETARIAT, alert, alertList, auditRow, harness, mount, never, problem, roster, routeOf, uuid, world } from './test/support';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const dialogButton = (name: string): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name });
const ok = () => ({ operation_id: 'op', status: 'OK', resource_version: 3, resource_id: uuid(1) });

describe('BAN-05, the alerts of the committee', () => {
  const route = routeOf('BAN-05', 'FR-BAN-05');
  const open = (overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = HEAD, command?: (operation: string, input: unknown) => unknown, path = '/') => {
    const h = harness(world(overrides), command);
    mount(<AlertsScreen route={route} />, h, { permissions, path });
    return h;
  };
  const A = uuid(301);

  it('UI-BAN-05: shows each alert with its severity in words and a shape, the value against the threshold, the owner, the action, the consequence and the hours to answer in', async () => {
    open();
    const card = await screen.findByTestId(`alert-${A}`);
    expect(card.textContent).toContain(word('ban.alert.type.provinceBehind'));
    expect(card.textContent).toContain(word('ban.alert.severity.urgent'));
    expect(card.textContent).toContain('⛔');
    expect(card.textContent).toContain(word('ban.alert.fact.valueOf', { value: '-4.00', threshold: '-3.00' }));
    expect(card.textContent).toContain('Sở Tài chính');
    expect(card.textContent).toContain('Họp với các chủ đầu tư chậm');
    expect(card.textContent).toContain('Năm đóng với vốn chưa giải ngân');
    expect(card.textContent).toContain(word('ban.alert.fact.hours', { hours: 48 }));
    expect(screen.getByTestId('policy-notice')).toBeTruthy();
  });

  it('acknowledges with a note against the version of the alert it saw, and says it was done', async () => {
    const h = open({}, HEAD, ok);
    fireEvent.click(await screen.findByTestId(`acknowledge-${A}`));
    expect((dialogButton(word('ban.alr.acknowledge.action')) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(await screen.findByLabelText(new RegExp(word('ban.alr.acknowledge.note'))), { target: { value: 'Đã nhận, sẽ họp' } });
    fireEvent.click(dialogButton(word('ban.alr.acknowledge.action')));
    expect((await screen.findByTestId('alerts-receipt')).textContent).toBe(word('ban.alr.acknowledge.receipt'));
    expect(h.command).toHaveBeenCalledWith('acknowledgeCommitteeAlert', expect.objectContaining({ path: { id: A }, body: { note: 'Đã nhận, sẽ họp' }, ifMatchVersion: 2 }));
  });

  it('says the alert changed in the meantime when the version is stale, and reads the list again', async () => {
    const h = open({}, HEAD, () => problem('VERSION_CONFLICT', 409));
    fireEvent.click(await screen.findByTestId(`acknowledge-${A}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(word('ban.alr.acknowledge.note'))), { target: { value: 'Đã nhận' } });
    fireEvent.click(dialogButton(word('ban.alr.acknowledge.action')));
    expect((await screen.findByRole('alert')).textContent).toContain(word('ban.common.error.versionConflict.text'));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'listCommitteeAlerts').length).toBe(2));
  });

  it('marks the numbers as old, with the time of the last good read, when the list cannot be read again after a change', async () => {
    let failing = false;
    const h = harness((operation) => (failing && operation === 'listCommitteeAlerts' ? problem('INTERNAL_ERROR', 500) : world()(operation)), () => {
      failing = true;
      return ok();
    });
    mount(<AlertsScreen route={route} />, h, { permissions: HEAD });
    fireEvent.click(await screen.findByTestId(`acknowledge-${A}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(word('ban.alr.acknowledge.note'))), { target: { value: 'Đã nhận' } });
    fireEvent.click(dialogButton(word('ban.alr.acknowledge.action')));
    await waitFor(() => expect(screen.getByText(/Số liệu cũ/)).toBeTruthy());
    expect(screen.getByTestId(`alert-${A}`)).toBeTruthy();
  });

  it('shows an acknowledged alert with who and why, and no button to acknowledge it again', async () => {
    open({ listCommitteeAlerts: alertList([alert(1, { status: 'ACKNOWLEDGED', acknowledged_by_name: 'Trưởng ban C', acknowledged_note: 'Đã nhận' })]) });
    const card = await screen.findByTestId(`alert-${A}`);
    expect(screen.getByTestId(`ack-${A}`).textContent).toBe(word('ban.alert.ack.text', { name: 'Trưởng ban C', note: 'Đã nhận' }));
    expect(card.querySelector('button')).toBeNull();
  });

  it('lets the secretariat evaluate again and says how many were opened, kept and closed; the head cannot', async () => {
    const h = open({}, SECRETARIAT, () => ({ ...ok(), opened: 1, kept: 2, resolved: 0 }));
    fireEvent.click(await screen.findByTestId('alerts-evaluate'));
    expect((await screen.findByTestId('alerts-receipt')).textContent).toBe(word('ban.alr.evaluate.receipt', { opened: 1, kept: 2, resolved: 0 }));
    expect(h.command).toHaveBeenCalledWith('evaluateCommitteeAlerts', expect.anything());
    cleanup();
    open({}, ['committee.read', 'committee.alert.acknowledge']);
    await screen.findByTestId(`alert-${A}`);
    expect(screen.queryByTestId('alerts-evaluate')).toBeNull();
    cleanup();
    open({}, READER);
    await screen.findByTestId(`alert-${A}`);
    expect(screen.queryByTestId(`acknowledge-${A}`)).toBeNull();
  });

  it('asks for the state chosen, and gives each empty list its own reason', async () => {
    const h = open();
    await screen.findByTestId(`alert-${A}`);
    expect(h.read).toHaveBeenCalledWith('listCommitteeAlerts', { query: { status: 'LIVE' } });
    fireEvent.change(screen.getByRole('combobox', { name: word('ban.alr.filter.status') }), { target: { value: 'RESOLVED' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listCommitteeAlerts', { query: { status: 'RESOLVED' } }));
    cleanup();
    open({ listCommitteeAlerts: alertList([]) });
    expect((await screen.findByTestId('alerts-empty')).textContent).toBe(word('ban.alr.empty.live.text'));
    cleanup();
    open({ listCommitteeAlerts: alertList([]) }, HEAD, undefined, '/?status=RESOLVED');
    expect((await screen.findByTestId('alerts-empty')).textContent).toBe(word('ban.alr.empty.filtered.text'));
  });

  it('shows loading, a service error with retry, permission denied and no right', async () => {
    open({ listCommitteeAlerts: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ listCommitteeAlerts: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ listCommitteeAlerts: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    const without = open({}, AUDITOR);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(without.read).not.toHaveBeenCalled();
  });
});

describe('BAN-06, the roster', () => {
  const route = routeOf('BAN-06', 'FR-BAN-06');
  const open = (overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = SECRETARIAT, command?: (operation: string, input: unknown) => unknown) => {
    const h = harness(world(overrides), command);
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.resolve([{ id: uuid(850), display_name: 'Trần Thị Bình' }, { id: uuid(851), display_name: 'Lê Văn Cường' }]));
    mount(<RosterScreen route={route} />, h, { permissions });
    return h;
  };
  const HEAD_PLACE = uuid(501);

  it('UI-BAN-06: shows each place with the agency, the decision, the days, the second factor, and warns when the role was not granted', async () => {
    open();
    const head = (await screen.findByText('Thành viên 1')).closest('tr') as HTMLElement;
    expect(head.textContent).toContain(word('ban.ros.role.head'));
    expect(head.textContent).toContain('PA05 · Công an tỉnh');
    expect(head.textContent).toContain('QD-57/2026');
    expect(head.textContent).toContain(word('ban.ros.days.open', { from: '01/01/2026' }));
    expect(head.textContent).toContain(word('ban.ros.mfa.required'));
    const missing = within(head).getByTestId(`role-missing-${HEAD_PLACE}`);
    expect(missing.textContent).toContain(word('ban.ros.roleMissing.label'));
    expect(missing.textContent).toContain('▲');
    const ended = screen.getByText('Thành viên 2').closest('tr') as HTMLElement;
    expect(ended.textContent).toContain(word('ban.ros.status.ended'));
    expect(ended.textContent).toContain('Chuyển công tác');
    expect(within(ended).queryByTestId(`role-missing-${uuid(502)}`)).toBeNull();
    expect(screen.getByTestId('roster-classification').textContent).toBe(word('ban.ros.classification.text', { level: 'PERSONAL' }));
  });

  it('ends a place with a reason of at least five characters, against the version it saw', async () => {
    const h = open({}, SECRETARIAT, ok);
    fireEvent.click(await screen.findByTestId(`end-${HEAD_PLACE}`));
    expect((dialogButton(word('ban.ros.end.confirm')) as HTMLButtonElement).disabled).toBe(true);
    const reason = await screen.findByLabelText(new RegExp(word('ban.ros.end.reason')));
    fireEvent.change(reason, { target: { value: 'ngắn' } });
    expect((dialogButton(word('ban.ros.end.confirm')) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'Chuyển công tác' } });
    fireEvent.click(dialogButton(word('ban.ros.end.confirm')));
    expect((await screen.findByTestId('roster-receipt')).textContent).toBe(word('ban.ros.end.receipt'));
    expect(h.command).toHaveBeenCalledWith('endCommitteeMember', expect.objectContaining({ path: { id: HEAD_PLACE }, body: { reason: 'Chuyển công tác' }, ifMatchVersion: 3 }));
  });

  it('appoints a person with the decision, the days and the second factor, and sends only what was typed', async () => {
    const h = open({}, SECRETARIAT, ok);
    fireEvent.click(await screen.findByTestId(`appoint-open-${uuid(600)}`));
    const person = (await screen.findByTestId('appoint-person')) as HTMLSelectElement;
    await waitFor(() => expect(within(person).getByText('Trần Thị Bình')).toBeTruthy());
    fireEvent.click(dialogButton(word('ban.ros.appoint.confirm')));
    expect((await screen.findByRole('alert')).textContent).toContain(word('ban.ros.appoint.invalid.text'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(person, { target: { value: uuid(850) } });
    fireEvent.change(screen.getByTestId('appoint-role'), { target: { value: 'DEPUTY' } });
    fireEvent.change(screen.getByTestId('appoint-agency-code'), { target: { value: 'PA05' } });
    fireEvent.change(screen.getByTestId('appoint-decision'), { target: { value: 'QD-58/2026' } });
    fireEvent.change(screen.getByTestId('appoint-from'), { target: { value: '2026-11-10' } });
    fireEvent.click(screen.getByTestId('appoint-mfa'));
    fireEvent.click(dialogButton(word('ban.ros.appoint.confirm')));
    expect((await screen.findByTestId('roster-receipt')).textContent).toBe(word('ban.ros.appoint.receipt'));
    expect(h.command).toHaveBeenCalledWith('appointCommitteeMember', expect.objectContaining({ body: { committee_id: uuid(600), membership_id: uuid(850), committee_role: 'DEPUTY', agency_code: 'PA05', decision_ref: 'QD-58/2026', valid_from: '2026-11-10', mfa_required: true } }));
  });

  it('says in words that nobody appoints themselves and that a committee has one head in force', async () => {
    let refusal = problem('VALIDATION_FAILED', 422, 'membership_id', { reason: 'self_appointment' });
    const h = open({}, SECRETARIAT, () => refusal);
    fireEvent.click(await screen.findByTestId(`appoint-open-${uuid(600)}`));
    const person = (await screen.findByTestId('appoint-person')) as HTMLSelectElement;
    await waitFor(() => expect(within(person).getByText('Trần Thị Bình')).toBeTruthy());
    fireEvent.change(person, { target: { value: uuid(850) } });
    fireEvent.click(dialogButton(word('ban.ros.appoint.confirm')));
    expect((await screen.findByRole('alert')).textContent).toContain(word('ban.common.error.selfAppointment.text'));
    refusal = problem('COMMITTEE_ROLE_TAKEN', 409, 'head');
    fireEvent.change(screen.getByTestId('appoint-role'), { target: { value: 'HEAD' } });
    fireEvent.click(dialogButton(word('ban.ros.appoint.confirm')));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(word('ban.common.error.roleTakenHead.text')));
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it('registers a committee with a code of capitals, and refuses a code that is not one before it asks', async () => {
    const h = open({}, SECRETARIAT, ok);
    fireEvent.click(await screen.findByTestId('register-open'));
    fireEvent.change(await screen.findByTestId('register-code'), { target: { value: 'ban 57' } });
    fireEvent.change(screen.getByTestId('register-name'), { target: { value: 'Ban chỉ đạo 57' } });
    fireEvent.click(dialogButton(word('ban.ros.register.confirm')));
    expect(await screen.findByText(word('ban.ros.register.code.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('register-code'), { target: { value: 'BAN57B' } });
    fireEvent.change(screen.getByTestId('register-basis'), { target: { value: 'Quyết định 57' } });
    fireEvent.click(dialogButton(word('ban.ros.register.confirm')));
    expect((await screen.findByTestId('roster-receipt')).textContent).toBe(word('ban.ros.register.receipt', { code: 'BAN57B' }));
    expect(h.command).toHaveBeenCalledWith('registerCommittee', expect.objectContaining({ body: { code: 'BAN57B', name: 'Ban chỉ đạo 57', legal_basis: 'Quyết định 57' } }));
  });

  it('offers a reader nothing to change, and gives an empty roster the words for who can fix it', async () => {
    open({}, READER);
    await screen.findByText('Thành viên 1');
    expect(screen.queryByTestId('register-open')).toBeNull();
    expect(screen.queryByTestId(`end-${HEAD_PLACE}`)).toBeNull();
    expect(screen.queryByTestId(`appoint-open-${uuid(600)}`)).toBeNull();
    cleanup();
    open({ getCommitteeRoster: roster({ committees: [] }) }, READER);
    expect((await screen.findByTestId('roster-empty')).textContent).toBe(word('ban.ros.empty.read.text'));
    cleanup();
    open({ getCommitteeRoster: roster({ committees: [{ ...roster().committees[0], members: [] }] }) });
    expect(await screen.findByTestId(`members-empty-${uuid(600)}`)).toBeTruthy();
    cleanup();
    open({ getCommitteeRoster: roster({ committees: [] }) });
    expect((await screen.findByTestId('roster-empty')).textContent).toBe(word('ban.ros.empty.manage.text'));
  });

  it('shows loading, a service error with retry, permission denied and no right', async () => {
    open({ getCommitteeRoster: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ getCommitteeRoster: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ getCommitteeRoster: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    const without = open({}, AUDITOR);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(without.read).not.toHaveBeenCalled();
  });
});

describe('BAN-07, the audit of views', () => {
  const route = routeOf('BAN-07', 'FR-BAN-07');
  const open = (overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = AUDITOR, path = '/') => {
    const h = harness((operation, input) => {
      const answer = world(overrides)(operation);
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
    });
    mount(<ViewAuditScreen route={route} />, h, { permissions, path });
    return h;
  };

  it('UI-BAN-07: shows who looked at which screen with which filters, as of which day, and at which assurance level, holding no figure', async () => {
    open({ listCommitteeViewAudit: { rows: [auditRow(1), auditRow(2, { screen: 'MEETING_PACK', filters: {}, committee_role: null, assurance_level: 'MFA', record_count: null, as_of: null, feed_basis: null })], next: null } });
    const first = (await screen.findByText('Người xem 1')).closest('tr') as HTMLElement;
    expect(first.textContent).toContain(word('ban.aud.screen.workspace'));
    expect(first.textContent).toContain('sector_code=GT');
    expect(first.textContent).toContain('08/11/2026');
    expect(first.textContent).toContain('12');
    expect(first.textContent).toContain('DIS_SNAPSHOT');
    expect(first.querySelector('[data-assurance="UNKNOWN"]')?.textContent).toContain(word('ban.aud.assurance.unknown'));
    expect(first.textContent).toContain(word('ban.aud.assurance.required'));
    const second = screen.getByText('Người xem 2').closest('tr') as HTMLElement;
    expect(second.textContent).toContain(word('ban.aud.screen.meetingPack'));
    expect(second.textContent).toContain(word('ban.aud.filters.none'));
    expect(second.textContent).toContain(word('ban.aud.role.none'));
    expect(second.querySelector('[data-assurance="MFA"]')?.textContent).toContain(word('ban.aud.assurance.mfa'));
    expect(screen.getByTestId('audit-end')).toBeTruthy();
  });

  it('pages by the cursor the server gave, newest first, adds the older rows below the others and ends when there is no cursor', async () => {
    const h = harness((operation, input) => {
      if (operation !== 'listCommitteeViewAudit') return new Error(`unexpected read ${operation}`);
      const before = (input as { query?: { before?: string } }).query?.before;
      return before === undefined ? { rows: [auditRow(1)], next: '2026-11-08T01:00:00.000Z|00000000-0000-4000-8000-0000000003e9' } : { rows: [auditRow(2)], next: null };
    });
    mount(<ViewAuditScreen route={route} />, h, { permissions: AUDITOR });
    await screen.findByText('Người xem 1');
    expect(screen.getByTestId('audit-count').textContent).toBe(word('ban.aud.count.text', { count: 1 }));
    fireEvent.click(screen.getByTestId('audit-older'));
    await screen.findByText('Người xem 2');
    expect(h.read).toHaveBeenLastCalledWith('listCommitteeViewAudit', { query: { limit: 50, before: '2026-11-08T01:00:00.000Z|00000000-0000-4000-8000-0000000003e9' } });
    expect(screen.getByTestId('audit-count').textContent).toBe(word('ban.aud.count.text', { count: 2 }));
    expect(screen.queryByTestId('audit-older')).toBeNull();
    expect(screen.getByTestId('audit-end')).toBeTruthy();
  });

  it('narrows by screen and by days, and says when nothing matches or nothing was ever logged', async () => {
    const h = open({ listCommitteeViewAudit: { rows: [], next: null } });
    expect((await screen.findByTestId('audit-empty')).textContent).toBe(word('ban.aud.empty.none.text'));
    fireEvent.change(screen.getByRole('combobox', { name: word('ban.aud.filter.screen') }), { target: { value: 'ALERTS' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listCommitteeViewAudit', { query: { limit: 50, screen: 'ALERTS' } }));
    expect((await screen.findByTestId('audit-empty')).textContent).toBe(word('ban.aud.empty.filtered.text'));
    fireEvent.change(screen.getByLabelText(word('ban.aud.filter.from')), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listCommitteeViewAudit', { query: { limit: 50, screen: 'ALERTS', from: '2026-11-01' } }));
  });

  it('needs the right to read the audit, not the right to read the workspace, and asks nothing without it', async () => {
    const h = open({}, READER);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows loading, a service error with retry and permission denied by the server', async () => {
    open({ listCommitteeViewAudit: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ listCommitteeViewAudit: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ listCommitteeViewAudit: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });

  it('is only ever read here: the other screens never ask for the audit', async () => {
    const h = open();
    await screen.findByText('Người xem 1');
    expect(h.read.mock.calls.every(([name]) => name === 'listCommitteeViewAudit')).toBe(true);
  });
});
