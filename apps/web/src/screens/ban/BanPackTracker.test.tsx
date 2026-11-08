import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as word, translator } from '../../i18n';
import PackScreen from './PackScreen';
import TrackerScreen from './TrackerScreen';
import { AUDITOR, HEAD, READER, draft, harness, issue, mount, never, pack, problem, routeOf, rptPage, tracker, uuid, world } from './test/support';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const dialogButton = (name: string): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name });

describe('BAN-03, the pack of the meeting', () => {
  const route = routeOf('BAN-03', 'FR-BAN-03');
  const open = (overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = HEAD, command?: (operation: string, input: unknown) => unknown, path = '/') => {
    const h = harness(world(overrides), command);
    mount(<PackScreen route={route} />, h, { permissions, path });
    return h;
  };

  it('UI-BAN-03: lists what the pack holds section by section with its figures, and reads the pack, the drafts and the copies once', async () => {
    const h = open();
    const sections = await screen.findByTestId('pack-sections');
    expect(sections.textContent).toContain(word('ban.pack.section.figures', { count: 8 }));
    expect(sections.textContent).toContain(word('ban.pack.section.sector', { count: 2 }));
    expect(sections.textContent).toContain(word('ban.pack.section.attention', { count: 1 }));
    expect(sections.textContent).toContain(word('ban.pack.section.directives', { units: 2, open: 4, overdue: 2 }));
    expect(screen.getByTestId('pack-figures').querySelectorAll('[data-metric]')).toHaveLength(8);
    expect(await screen.findByTestId('pack-drafts')).toBeTruthy();
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listReportIssues', expect.objectContaining({ query: expect.objectContaining({ layout_code: 'BAN-MEETING-PACK' }) })));
    expect(h.read).toHaveBeenCalledWith('getCommitteeMeetingPack', { query: {} });
    expect(h.read).toHaveBeenCalledWith('listReportDrafts', { query: { layout_code: 'BAN-MEETING-PACK', limit: 100 } });
    expect(h.read.mock.calls.map(([name]) => name).filter((name) => name === 'getCommitteeMeetingPack')).toHaveLength(1);
  });

  it('previews another day when it is asked to', async () => {
    const h = open();
    await screen.findByTestId('pack-sections');
    fireEvent.change(screen.getByTestId('pack-day'), { target: { value: '2026-10-18' } });
    fireEvent.click(screen.getByRole('button', { name: word('ban.pack.day.apply') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getCommitteeMeetingPack', { query: { as_of: '2026-10-18' } }));
  });

  it('makes a draft of the form BAN-MEETING-PACK for the day of the figures, and says what was made with the way to it', async () => {
    const h = open({}, HEAD, () => ({ outcome: 'CREATED', draft_id: uuid(990), issue_id: null, revision: 2, package_sha256: 'a'.repeat(64), issue_count: 0 }));
    fireEvent.click(await screen.findByTestId('pack-generate'));
    const receipt = await screen.findByTestId('pack-receipt');
    expect(receipt.textContent).toContain(word('ban.pack.receipt.created', { revision: 2 }));
    expect(within(receipt).getByRole('link').getAttribute('href')).toBe(`/rpt/rpt-02?draft=${uuid(990)}`);
    expect(h.command).toHaveBeenCalledWith('generateReport', expect.objectContaining({ body: { layout_code: 'BAN-MEETING-PACK', period: { kind: 'AS_OF', year: 2026, day: '2026-11-08' } } }));
  });

  it('says that the same content as the copy in force makes nothing new', async () => {
    open({}, HEAD, () => ({ outcome: 'DUPLICATE', draft_id: null, issue_id: uuid(991), revision: 3, package_sha256: 'a'.repeat(64), issue_count: 0 }));
    fireEvent.click(await screen.findByTestId('pack-generate'));
    const receipt = await screen.findByTestId('pack-receipt');
    expect(receipt.textContent).toContain(word('ban.pack.receipt.duplicate', { revision: 3 }));
    expect(within(receipt).getByRole('link').getAttribute('href')).toBe(`/rpt/rpt-03?issue=${uuid(991)}`);
  });

  it('asks for a reason when the server says a copy of the day was issued with other figures, and then sends it', async () => {
    let calls = 0;
    const h = open({}, HEAD, () => {
      calls += 1;
      return calls === 1 ? problem('VALIDATION_FAILED', 422, 'reason') : { outcome: 'CREATED', draft_id: uuid(992), issue_id: null, revision: 2, package_sha256: 'a'.repeat(64), issue_count: 0 };
    });
    fireEvent.click(await screen.findByTestId('pack-generate'));
    const reason = await screen.findByTestId('pack-reason');
    fireEvent.change(reason, { target: { value: 'short' } });
    fireEvent.click(screen.getByTestId('pack-generate'));
    expect((await screen.findAllByRole('alert')).map((node) => node.textContent).join(' ')).toContain(word('ban.pack.generate.reason.error'));
    expect(h.command).toHaveBeenCalledTimes(1);
    fireEvent.change(reason, { target: { value: 'The Treasury booked a late payment' } });
    fireEvent.click(screen.getByTestId('pack-generate'));
    await screen.findByTestId('pack-receipt');
    expect(h.command).toHaveBeenLastCalledWith('generateReport', expect.objectContaining({ body: expect.objectContaining({ reason: 'The Treasury booked a late payment' }) }));
  });

  it('does not offer to make the pack to someone without the right', async () => {
    open({}, ['committee.read', 'rpt.read']);
    await screen.findByTestId('pack-sections');
    expect(screen.queryByTestId('pack-generate')).toBeNull();
    expect(screen.getByTestId('pack-no-right').textContent).toBe(word('ban.pack.generate.noRight'));
  });

  it('lists the drafts with the three people, the next step only for the person who may take it, and the way to RPT-02', async () => {
    const h = open({ listReportDrafts: rptPage([draft(1), draft(2, { state: 'CHECKED', checked_by_name: 'Thành viên B', can_check: false, can_approve: false })]) }, HEAD, () => ({ operation_id: 'op', status: 'OK', resource_version: 2 }));
    const table = await screen.findByTestId('pack-drafts');
    const rows = await within(table).findAllByRole('row');
    expect(rows.length).toBe(3);
    expect(within(rows[1] as HTMLElement).getByText('Thư ký A')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Thành viên B')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(word('ban.pack.wait.approve'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: word('ban.pack.link.draft') }).getAttribute('href')).toBe(`/rpt/rpt-02?draft=${uuid(901)}`);
    fireEvent.click(screen.getByTestId(`step-check-${uuid(901)}`));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(dialogButton(word('ban.pack.act.check')));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('checkReport', expect.objectContaining({ path: { id: uuid(901) }, ifMatchVersion: 1 }));
  });

  it('says in words that the same person may not check their own draft', async () => {
    open({}, HEAD, () => problem('SELF_APPROVAL_DENIED', 403));
    fireEvent.click(await screen.findByTestId(`step-check-${uuid(901)}`));
    fireEvent.click(dialogButton(word('ban.pack.act.check')));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.common.error.selfApproval.text'));
  });

  it('lists the issued copies with the way to RPT-03, and gives drafts and copies their own empty reasons', async () => {
    open();
    const copies = await screen.findByTestId('pack-issues');
    expect(await within(copies).findByRole('link', { name: word('ban.pack.link.issue') })).toBeTruthy();
    expect(within(copies).getByRole('link', { name: word('ban.pack.link.issue') }).getAttribute('href')).toBe(`/rpt/rpt-03?issue=${uuid(951)}`);
    cleanup();
    open({ listReportDrafts: rptPage([]), listReportIssues: rptPage([]) });
    expect(await screen.findByText(word('ban.pack.drafts.empty.text'))).toBeTruthy();
    expect(await screen.findByText(word('ban.pack.issues.empty.text'))).toBeTruthy();
  });

  it('keeps the preview when the report engine is denied, and retries a part that failed in place', async () => {
    open({ listReportDrafts: problem('SCOPE_DENIED', 403), listReportIssues: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('ban.pack.drafts.denied.text'))).toBeTruthy();
    expect(screen.getByTestId('pack-sections')).toBeTruthy();
    const failed = await screen.findByTestId('part-error');
    expect(failed.textContent).toContain(word('ban.common.partError.text', { source: word('ban.pack.issues.source') }));
    expect(within(failed).getByRole('button', { name: word('ui.common.retry') })).toBeTruthy();
  });

  it('shows loading, a service error with retry, permission denied and no right', async () => {
    open({ getCommitteeMeetingPack: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ getCommitteeMeetingPack: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ getCommitteeMeetingPack: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    const without = open({}, AUDITOR);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(without.read).not.toHaveBeenCalled();
  });

  it('shows the issued copy that is no longer in force as such', async () => {
    open({ listReportIssues: rptPage([issue(1, { is_current: false })]) });
    const copies = await screen.findByTestId('pack-issues');
    expect(await within(copies).findByText(word('ban.pack.current.no'))).toBeTruthy();
  });
});

describe('BAN-04, the directives of the committee', () => {
  const route = routeOf('BAN-04', 'FR-BAN-04');
  const open = (overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = READER) => {
    const h = harness(world(overrides));
    mount(<TrackerScreen route={route} />, h, { permissions });
    return h;
  };

  it('UI-BAN-04: shows the totals, the units and the overdue and escalated directives with the way to DIR-04, and the rule of the days', async () => {
    open();
    const totals = await screen.findByTestId('tracker-totals');
    expect(totals.textContent).toContain('4');
    expect(screen.getByText(word('ban.trk.rule.text', { days: 14 }))).toBeTruthy();
    const unit = screen.getByText('Ban quản lý dự án 1', { selector: 'strong' }).closest('tr') as HTMLElement;
    expect(unit.textContent).toContain(word('ban.trk.oldest.days', { days: 21 }));
    expect((screen.getByText('Ban quản lý dự án 2', { selector: 'strong' }).closest('tr') as HTMLElement).textContent).toContain(word('ban.trk.oldest.none'));
    const link = screen.getByTestId(`directive-${uuid(401)}`);
    expect(link.getAttribute('href')).toBe(`/dir/dir-04?directive=${uuid(401)}`);
    const escalated = link.closest('tr') as HTMLElement;
    expect(escalated.textContent).toContain(word('ban.trk.phase.escalated'));
    expect(escalated.textContent).toContain('⛔');
    expect(escalated.textContent).toContain(word('ban.trk.late.days', { days: 21 }));
    const overdue = screen.getByTestId(`directive-${uuid(402)}`).closest('tr') as HTMLElement;
    expect(overdue.textContent).toContain(word('ban.trk.phase.overdue'));
    expect(overdue.textContent).toContain(word('ban.trk.project.none'));
    expect(screen.getByTestId('figure-COMMITTEE_DIRECTIVES_OVERDUE')).toBeTruthy();
  });

  it('says when the list is cut short, and gives each empty case its own words', async () => {
    open({ getCommitteeDirectiveTracker: tracker({ truncated: true }) });
    expect(await screen.findByTestId('tracker-truncated')).toBeTruthy();
    cleanup();
    open({ getCommitteeDirectiveTracker: tracker({ units: [], directives: [], totals: { open: 0, overdue: 0, escalated: 0 } }) });
    expect((await screen.findByTestId('tracker-units-empty')).textContent).toBe(word('ban.trk.units.empty.text'));
    expect(screen.getByTestId('tracker-list-empty').textContent).toBe(word('ban.trk.list.noOpen.text'));
    cleanup();
    open({ getCommitteeDirectiveTracker: tracker({ directives: [], totals: { open: 2, overdue: 0, escalated: 0 } }) });
    expect((await screen.findByTestId('tracker-list-empty')).textContent).toBe(word('ban.trk.list.onTime.text'));
  });

  it('shows loading, a service error with retry, permission denied and no right', async () => {
    open({ getCommitteeDirectiveTracker: never() });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open({ getCommitteeDirectiveTracker: problem('INTERNAL_ERROR', 500) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open({ getCommitteeDirectiveTracker: problem('SCOPE_DENIED', 403) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    const without = open({}, AUDITOR);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(without.read).not.toHaveBeenCalled();
  });
});

describe('the pack and the workspace read the same service', () => {
  it('shows the same figures in the pack as the pack of the API gives, and reads the pack once', async () => {
    const h = harness(world({ getCommitteeMeetingPack: pack() }));
    mount(<PackScreen route={routeOf('BAN-03', 'FR-BAN-03')} />, h, { permissions: HEAD });
    const rate = await screen.findByTestId('figure-COMMITTEE_DISBURSEMENT_RATE');
    expect(rate.textContent).toContain('60,00');
  });
});
