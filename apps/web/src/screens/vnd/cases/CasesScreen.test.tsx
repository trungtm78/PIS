import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import CasesScreen from './CasesScreen';
import { ALL, CONTRACTOR, DOCUMENT, READER, caseDetail, caseEvent, caseLine, casePage, client, mount, routeOf, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string, detail?: string, extensions?: Record<string, unknown>) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), ...(extensions === undefined ? {} : { extensions }) });
const route = routeOf('VND-03', 'FR-VND-03');
const CASE = uuid('0010', 1);
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string | RegExp): RegExp => (typeof label === 'string' ? new RegExp(escaped(label)) : label);

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
}

function list(items: Array<Record<string, unknown>> = [caseLine(1), caseLine(2, { status: 'DECIDED', clock: 'MET', decision: 'BAN', ban_months: 24, decision_scope: 'PROVINCE', decided_by_name: 'Phạm Quốc Bảo', subject_name: 'Liên danh Bắc Nam', subject_kind: 'JOINT_VENTURE' })], options: Options = {}, extra: World['answers'] = {}) {
  const world: World = { answers: { listVendorRestrictionCases: casePage(items), ...extra }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<CasesScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: options.path ?? '/vnd/vnd-03', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

function detail(over: Record<string, unknown> = {}, line: Record<string, unknown> = {}, options: Options = {}) {
  const world: World = { answers: { getVendorRestrictionCase: caseDetail(caseLine(1, line), over) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<CasesScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: `/vnd/vnd-03?case=${CASE}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-case-id]'));
const caseLoaded = async (): Promise<void> => {
  await screen.findByTestId('case-facts');
};

describe('CasesScreen (VND-03): the list of debarment cases', () => {
  it('lists the cases with the subject, the groups, the status pill, the clock and the decision', async () => {
    list();
    await screen.findByText('HSC-2026-001');
    const [open, decided] = rows();
    expect(within(open as HTMLElement).getByRole('link', { name: 'HSC-2026-001' }).getAttribute('href')).toBe(`/vnd/vnd-03?case=${uuid('0010', 1)}`);
    expect(open?.textContent).toContain('Công ty nhà thầu 1');
    expect(open?.textContent).toContain(word('vnd.subject.contractor.name'));
    expect(open?.textContent).toContain(word('vnd.group.group2.name'));
    expect(open?.textContent).toContain(word('vnd.caseStatus.proposed.name'));
    expect(open?.textContent).toContain(word('vnd.clock.onTime.name'));
    expect(open?.textContent).toContain(word('vnd.cases.decision.none.text'));
    expect(decided?.textContent).toContain(word('vnd.subject.jointVenture.name'));
    expect(decided?.textContent).toContain(text('vnd.cases.decision.months.text', { months: 24 }));
    expect(decided?.textContent).toContain(word('vnd.scope.province.name'));
    expect(decided?.textContent).toContain(word('vnd.clock.met.name'));
  });

  it('shows the clock of an open case with the days left or late against the day of the answer, and a met clock without them', async () => {
    list([
      caseLine(1, { clock: 'DUE_SOON', decide_by: '2026-11-09T02:00:00.000Z' }),
      caseLine(2, { clock: 'OVERDUE', decide_by: '2026-11-04T02:00:00.000Z' }),
      caseLine(3, { clock: 'MET_LATE', status: 'DECIDED', decide_by: '2026-11-04T02:00:00.000Z' }),
    ]);
    await screen.findByText('HSC-2026-001');
    const [soon, over, late] = rows();
    expect(soon?.textContent).toContain(word('vnd.clock.dueSoon.name'));
    expect(soon?.textContent).toContain(text('alerts.deadline.left', { days: 1, date: '09/11' }));
    expect(over?.textContent).toContain(word('vnd.clock.overdue.name'));
    expect(over?.textContent).toContain(text('alerts.deadline.late', { days: 4 }));
    expect(late?.textContent).toContain(word('vnd.clock.metLate.name'));
    expect(late?.textContent).not.toContain('Quá hạn');
  });

  it('puts the counts in a strip with the "i" of the decision clock and the unverified flag', async () => {
    list();
    await screen.findByText('HSC-2026-001');
    const strip = screen.getByRole('group', { name: word('vnd.cases.counts.label') });
    expect(within(strip).getByText(word('vnd.cases.counts.open.name'))).toBeTruthy();
    expect(strip.textContent).toContain('2');
    expect(within(strip).getAllByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.cases.figure.clock.name') }) })).toHaveLength(4);
    fireEvent.click(within(strip).getAllByRole('button')[0] as HTMLElement);
    const panel = screen.getByRole('dialog', { name: word('vnd.cases.figure.clock.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Formula of VENDOR_DEBARMENT');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
    expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(0);
  });

  it('colours the overdue count and keeps the strip free of zero while loading', async () => {
    list([caseLine(1)], {}, { listVendorRestrictionCases: casePage([caseLine(1)], { counts: { open: 1, overdue: 1, decided_in_time: 0, decided_late: 0 } }) });
    await screen.findByText('HSC-2026-001');
    expect(document.querySelector('.ui-kpi.ui-tone-danger')).toBeTruthy();
  });

  it('filters by status, by the open ones and by the contractor, and sends only what is set', async () => {
    const { h } = list();
    await screen.findByText('HSC-2026-001');
    expect(h.read).toHaveBeenCalledWith('listVendorRestrictionCases', { query: {} });
    fireEvent.change(screen.getByLabelText(word('vnd.cases.filter.status.label')), { target: { value: 'NOTICE_SENT' } });
    fireEvent.click(screen.getByLabelText(word('vnd.cases.filter.open.label')));
    fireEvent.change(screen.getByLabelText(word('vnd.cases.filter.contractor.label')), { target: { value: ` ${CONTRACTOR} ` } });
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorRestrictionCases', { query: { status: 'NOTICE_SENT', open: true, contractor_id: CONTRACTOR } }));
  });

  it('takes the contractor from the address as the filter, and refuses a contractor that is not an identifier without asking the server', async () => {
    const { h } = list(undefined, { path: `/vnd/vnd-03?contractor=${CONTRACTOR}` });
    await screen.findByText('HSC-2026-001');
    expect(h.read).toHaveBeenCalledWith('listVendorRestrictionCases', { query: { contractor_id: CONTRACTOR } });
    cleanup();
    const second = list(undefined, { path: '/vnd/vnd-03?contractor=not-an-id' });
    await screen.findByTestId('contractor-filter-error');
    expect(second.h.read).toHaveBeenCalledWith('listVendorRestrictionCases', { query: {} });
  });

  it('EMPTY: says there is no case, and when a filter found nothing offers to clear it', async () => {
    list([]);
    expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    cleanup();
    const { h } = list(undefined, {}, { listVendorRestrictionCases: (input: unknown) => casePage((input as { query?: { open?: boolean } })?.query?.open === true ? [] : [caseLine(1)]) });
    await screen.findByText('HSC-2026-001');
    fireEvent.click(screen.getByLabelText(word('vnd.cases.filter.open.label')));
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    expect(await screen.findByText(word('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('ui.dataTable.clearFilters') }));
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listVendorRestrictionCases', { query: {} }));
  });

  it('LOADING, ERROR with retry, FORBIDDEN', async () => {
    const pending = client({ answers: {} });
    pending.read.mockImplementation(() => new Promise(() => undefined));
    mount(<CasesScreen route={route} />, pending, { permissions: ALL, path: '/vnd/vnd-03' });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    list(undefined, { failing: { listVendorRestrictionCases: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByText('HSC-2026-001')).toBeTruthy();
    cleanup();
    list(undefined, { failing: { listVendorRestrictionCases: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
  });

  it('STALE: keeps the last list when a refresh fails', async () => {
    let calls = 0;
    const world: World = { answers: { listVendorRestrictionCases: () => (++calls === 1 ? casePage([caseLine(1)]) : problem(500, 'INTERNAL_ERROR')) } };
    const mounted = mount(<CasesScreen route={route} />, client(world), { permissions: ALL, path: '/vnd/vnd-03' });
    await screen.findByText('HSC-2026-001');
    await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
    expect(await screen.findByTestId('stale-notice')).toBeTruthy();
    expect(screen.getByText('HSC-2026-001')).toBeTruthy();
  });

  describe('opening a case', () => {
    const groupsLabel = word('vnd.cases.field.groups.label');

    it('opens a case with the body of the request and goes to the new case', async () => {
      const { h } = list(undefined, { command: () => ({ operation_id: 'o', status: 'OK', resource_version: 1, resource_id: CASE }) }, { getVendorRestrictionCase: caseDetail(caseLine(1)) });
      await screen.findByText('HSC-2026-001');
      fireEvent.click(screen.getByTestId('open-case'));
      const form = dialog(word('vnd.cases.open.title'));
      const send = within(form).getByRole('button', { name: word('vnd.cases.open.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.cases.field.contractor.label'), CONTRACTOR);
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group2.name')));
      type(form, word('vnd.cases.field.summary.label'), 'Nộp bảo đảm dự thầu giả mạo trong gói thầu xây lắp');
      type(form, word('vnd.cases.field.violationOn.label'), '2026-09-15');
      type(form, word('vnd.cases.field.trigger.label'), 'AUDIT_CONCLUSION');
      type(form, word('vnd.cases.field.triggerRef.label'), 'KL-12');
      type(form, word('vnd.cases.field.proposal.label'), DOCUMENT);
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('openVendorRestrictionCase', {
        body: {
          subject_kind: 'CONTRACTOR',
          contractor_id: CONTRACTOR,
          trigger_kind: 'AUDIT_CONCLUSION',
          trigger_ref: 'KL-12',
          violation_groups: ['GROUP_2'],
          violation_summary: 'Nộp bảo đảm dự thầu giả mạo trong gói thầu xây lắp',
          violation_on: '2026-09-15',
          proposal_document_id: DOCUMENT,
        },
        attempt: { key: expect.any(String) },
      });
      expect(await screen.findByTestId('case-facts')).toBeTruthy();
      expect(groupsLabel).toBeTruthy();
    });

    it('keeps the minimum of the summary and asks for the group and the day', async () => {
      list();
      await screen.findByText('HSC-2026-001');
      fireEvent.click(screen.getByTestId('open-case'));
      const form = dialog(word('vnd.cases.open.title'));
      const send = within(form).getByRole('button', { name: word('vnd.cases.open.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.cases.field.contractor.label'), CONTRACTOR);
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group1.name')));
      type(form, word('vnd.cases.field.violationOn.label'), '2026-09-15');
      type(form, word('vnd.cases.field.summary.label'), 'Quá ngắn');
      expect(send.disabled).toBe(true);
      fireEvent.blur(within(form).getByLabelText(labelOf(word('vnd.cases.field.summary.label'))));
      expect(within(form).getByText(text('vnd.field.short.text', { min: 20 }))).toBeTruthy();
      type(form, word('vnd.cases.field.summary.label'), 'Nộp bảo đảm dự thầu giả mạo trong gói thầu');
      expect(send.disabled).toBe(false);
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group1.name')));
      expect(send.disabled).toBe(true);
    });

    it('asks for the joint venture, not the contractor, when the subject is a joint venture', async () => {
      const { h } = list();
      await screen.findByText('HSC-2026-001');
      fireEvent.click(screen.getByTestId('open-case'));
      const form = dialog(word('vnd.cases.open.title'));
      type(form, word('vnd.cases.field.subject.label'), 'JOINT_VENTURE');
      expect(within(form).queryByLabelText(labelOf(word('vnd.cases.field.contractor.label')))).toBeNull();
      type(form, word('vnd.cases.field.venture.label'), uuid('0013', 1));
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group3.name')));
      type(form, word('vnd.cases.field.summary.label'), 'Nộp bảo đảm dự thầu giả mạo trong gói thầu');
      type(form, word('vnd.cases.field.violationOn.label'), '2026-09-15');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.open.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('openVendorRestrictionCase', expect.objectContaining({ body: expect.objectContaining({ subject_kind: 'JOINT_VENTURE', joint_venture_id: uuid('0013', 1), violation_groups: ['GROUP_3'] }) })));
      const body = (h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
      expect(body).not.toHaveProperty('contractor_id');
    });

    it('says the refusals of the server: a duplicate case and a violation past the limitation', async () => {
      let attempt = 0;
      list(undefined, { command: () => Promise.reject(++attempt === 1 ? problem(409, 'RESTRICTION_CASE_DUPLICATE') : problem(422, 'RESTRICTION_CASE_TIME_BARRED', undefined, { limit_on: '2026-09-14' })) });
      await screen.findByText('HSC-2026-001');
      fireEvent.click(screen.getByTestId('open-case'));
      const form = dialog(word('vnd.cases.open.title'));
      type(form, word('vnd.cases.field.contractor.label'), CONTRACTOR);
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group2.name')));
      type(form, word('vnd.cases.field.summary.label'), 'Nộp bảo đảm dự thầu giả mạo trong gói thầu');
      type(form, word('vnd.cases.field.violationOn.label'), '2026-09-15');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.open.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.caseDuplicate.text'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.open.confirm') }));
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe(text('vnd.error.timeBarred.text', { day: '2026-09-14' })));
    });

    it('opens a case from a record of the national network by its id', async () => {
      const { h } = list(undefined, { command: () => ({ operation_id: 'o', status: 'OK', resource_version: 1, resource_id: CASE }) }, { getVendorRestrictionCase: caseDetail(caseLine(1)) });
      await screen.findByText('HSC-2026-001');
      fireEvent.click(screen.getByTestId('open-egp-case'));
      const form = dialog(word('vnd.cases.egp.title'));
      const send = within(form).getByRole('button', { name: word('vnd.cases.egp.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.cases.field.egpRecord.label'), 'khong-phai-ma');
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group1.name')));
      expect(send.disabled).toBe(true);
      type(form, word('vnd.cases.field.egpRecord.label'), uuid('0020', 5));
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('openVendorRestrictionCaseFromEgpRecord', { body: { egp_record_id: uuid('0020', 5), violation_groups: ['GROUP_1'] }, attempt: { key: expect.any(String) } }));
    });

    it('offers no opening without the right to propose, nor in a read-only workspace', async () => {
      list(undefined, { permissions: READER });
      await screen.findByText('HSC-2026-001');
      expect(screen.queryByTestId('open-case')).toBeNull();
      cleanup();
      list(undefined, { mode: 'READ_ONLY' });
      await screen.findByText('HSC-2026-001');
      expect(screen.queryByTestId('open-case')).toBeNull();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
    });
  });
});

describe('CasesScreen (VND-03): one case', () => {
  const stepOf = (code: string): HTMLElement => document.querySelector(`[data-step="${code}"]`) as HTMLElement;

  it('shows the steps with the one the case is at', async () => {
    detail({ events: [caseEvent(1), caseEvent(2, { move: 'SEND_NOTICE', from_status: 'PROPOSED', to_status: 'NOTICE_SENT' })] }, { status: 'NOTICE_SENT' });
    await caseLoaded();
    expect(screen.getByTestId('case-stepper').getAttribute('data-status')).toBe('NOTICE_SENT');
    expect(stepOf('PROPOSED').className).toContain('ui-stepper__step--done');
    expect(stepOf('NOTICE_SENT').getAttribute('aria-current')).toBe('step');
    expect(stepOf('RESPONSE_RECEIVED').className).toContain('ui-stepper__step--upcoming');
    expect(within(stepOf('END')).getByText(word('vnd.cases.step.end.name'))).toBeTruthy();
  });

  it('shows how a case ended: the steps it never reached are skipped and the end is named', async () => {
    detail({ events: [caseEvent(1), caseEvent(2, { move: 'WITHDRAW', from_status: 'PROPOSED', to_status: 'DISMISSED' })], end_reason: 'Rút đề nghị vì thiếu căn cứ' }, { status: 'DISMISSED' });
    await caseLoaded();
    expect(stepOf('NOTICE_SENT').className).toContain('ui-stepper__step--skipped');
    expect(stepOf('END').getAttribute('aria-current')).toBe('step');
    expect(within(stepOf('END')).getByText(word('vnd.caseStatus.dismissed.name'))).toBeTruthy();
    expect(screen.getByTestId('fact-end-reason').textContent).toContain('Rút đề nghị vì thiếu căn cứ');
  });

  it('shows the facts of the case, the groups with the behaviours they cover, the proposer and the documents', async () => {
    detail({ notice_document_id: uuid('0009', 7) });
    await caseLoaded();
    const value = (id: string): string => screen.getByTestId(id).querySelector('dd')?.textContent ?? '';
    expect(value('fact-no')).toBe('HSC-2026-001');
    expect(value('fact-subject')).toContain('Công ty nhà thầu 1');
    expect(within(screen.getByTestId('fact-subject')).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
    expect(value('fact-trigger')).toContain(word('vnd.trigger.investorProposal.name'));
    expect(value('fact-groups')).toContain(word('vnd.group.group2.name'));
    expect(value('fact-groups')).toContain('Cản trở');
    expect(value('fact-summary')).toBe('Nộp bảo đảm dự thầu giả mạo trong gói thầu xây lắp');
    expect(value('fact-violation-on')).toBe('15/09/2026');
    expect(value('fact-proposed')).toContain('Lê Thị Hoa');
    expect(value('fact-documents')).toContain(text('vnd.cases.fact.document.proposal', { id: DOCUMENT }));
    expect(value('fact-documents')).toContain(text('vnd.cases.fact.document.notice', { id: uuid('0009', 7) }));
  });

  it('shows the clock of the decision with the days left, its "i" and the unverified flag', async () => {
    detail({}, { clock: 'DUE_SOON', decide_by: '2026-11-09T02:00:00.000Z' });
    await caseLoaded();
    const clock = screen.getByTestId('fact-clock');
    expect(clock.textContent).toContain(word('vnd.clock.dueSoon.name'));
    expect(clock.textContent).toContain(text('alerts.deadline.left', { days: 1, date: '09/11' }));
    expect(clock.textContent).toContain(text('vnd.cases.fact.decideBy.text', { time: '09/11/2026 09:00' }));
    expect(within(clock).getByText(word('vnd.flag.unverified.badge'))).toBeTruthy();
    fireEvent.click(within(clock).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.cases.figure.clock.name') }) }));
    expect(screen.getByRole('dialog', { name: word('vnd.cases.figure.clock.name') })).toBeTruthy();
  });

  it('shows the maker and the checker of the case', async () => {
    detail({}, { status: 'DECIDED', decision: 'BAN', decided_by_name: 'Phạm Quốc Bảo', decided_at: '2026-11-03T02:00:00.000Z', decision_scope: 'PROVINCE', ban_months: 24, effective_from: '2026-12-01', effective_until: '2028-11-30', decided_late: true });
    await caseLoaded();
    const badge = screen.getByRole('group', { name: word('ui.makerChecker.label') });
    expect(badge.textContent).toContain(text('ui.makerChecker.maker', { name: 'Lê Thị Hoa' }));
    expect(badge.textContent).toContain(text('ui.makerChecker.checker', { name: 'Phạm Quốc Bảo' }));
    const facts = screen.getByTestId('decision-facts');
    expect(facts.textContent).toContain(word('vnd.cases.decision.ban.name'));
    expect(facts.textContent).toContain(word('vnd.scope.province.name'));
    expect(facts.textContent).toContain(text('vnd.cases.decision.months.text', { months: 24 }));
    expect(facts.textContent).toContain('01/12/2026 – 30/11/2028');
    expect(facts.textContent).toContain(word('vnd.cases.decision.late.badge'));
  });

  it('says the ban period the groups allow and what the shortest and the longest ban would end on, flagged unverified', async () => {
    detail({}, { violation_groups: ['GROUP_2'] });
    await caseLoaded();
    expect(screen.getByTestId('period-range').textContent).toContain(text('vnd.cases.period.range.text', { min: 12, max: 36 }));
    expect(screen.getByTestId('period-example').textContent).toContain('đến hết');
    expect(within(screen.getByTestId('period-range')).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.cases.figure.period.name') }) })).toBeTruthy();
    expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(1);
  });

  it('says the range cannot be worked out for a group it has no period for', async () => {
    detail({}, { violation_groups: ['GROUP_9'] });
    await caseLoaded();
    expect(screen.getByTestId('period-unknown').textContent).toBe(word('vnd.cases.period.unknown.text'));
  });

  it('shows the suggestion to widen the ban as text, with no button that bans', async () => {
    detail({ escalation: { decisions_in_force: 5, suggestion: 'NATIONWIDE' } });
    await caseLoaded();
    expect(screen.getByTestId('escalation-count').textContent).toContain(text('vnd.cases.escalation.count.text', { count: 5 }));
    const suggestion = screen.getByTestId('escalation-suggestion');
    expect(suggestion.getAttribute('data-suggestion')).toBe('NATIONWIDE');
    expect(suggestion.textContent).toBe(text('vnd.cases.escalation.suggestion.text', { scope: word('vnd.suggestion.nationwide.name') }));
    expect(screen.queryByRole('button', { name: /toàn quốc/i })).toBeNull();
    cleanup();
    detail({ escalation: { decisions_in_force: 1, suggestion: 'NONE' } });
    await caseLoaded();
    expect(screen.getByTestId('escalation-none')).toBeTruthy();
    expect(screen.queryByTestId('escalation-suggestion')).toBeNull();
  });

  it('lists the members reached with whether the restriction is recorded', async () => {
    detail({ members: [{ contractor_id: CONTRACTOR, contractor_name: 'Công ty nhà thầu 1', restriction_id: null }, { contractor_id: uuid('0001', 2), contractor_name: 'Công ty nhà thầu 2', restriction_id: uuid('0008', 1) }] });
    await caseLoaded();
    const [first, second] = Array.from(document.querySelectorAll('tr[data-member-id]'));
    expect(first?.textContent).toContain(word('vnd.cases.members.notYet.text'));
    expect(second?.textContent).toContain(word('vnd.cases.members.recorded.text'));
  });

  it('shows the history by day with who did each step', async () => {
    detail({ events: [caseEvent(1), caseEvent(2, { move: 'SEND_NOTICE', from_status: 'PROPOSED', to_status: 'NOTICE_SENT', actor_name: 'Nguyễn Văn An', note: 'Đã gửi thư bảo đảm', occurred_at: '2026-11-02T02:00:00.000Z' })] });
    await caseLoaded();
    const entries = Array.from(document.querySelectorAll('[data-entry-id]'));
    expect(entries).toHaveLength(2);
    expect(document.body.textContent).toContain(text('vnd.cases.timeline.entry.text', { move: word('vnd.move.sendNotice.name'), from: word('vnd.caseStatus.proposed.name'), to: word('vnd.caseStatus.noticeSent.name') }));
    expect(document.body.textContent).toContain('Nguyễn Văn An');
    expect(document.body.textContent).toContain('Đã gửi thư bảo đảm');
  });

  describe('the steps of the case', () => {
    it('offers the moves of the status when the answer allows: send the notice or withdraw for a proposal', async () => {
      detail({ may_advance: true });
      await caseLoaded();
      expect(screen.getByTestId('move-SEND_NOTICE')).toBeTruthy();
      expect(screen.getByTestId('move-WITHDRAW')).toBeTruthy();
      expect(screen.queryByTestId('move-RECORD_RESPONSE')).toBeNull();
      expect(screen.queryByTestId('decide')).toBeNull();
    });

    it('sends the notice with its document, under the version of the case', async () => {
      const { h } = detail({ may_advance: true }, { version: 5 });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('move-SEND_NOTICE'));
      const form = dialog(word('vnd.move.sendNotice.name'));
      type(form, word('vnd.cases.field.notice.label'), uuid('0009', 3));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.move.sendNotice.name') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('advanceVendorRestrictionCase', { path: { id: CASE }, ifMatchVersion: 5, body: { move: 'SEND_NOTICE', notice_document_id: uuid('0009', 3) }, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.move.sendNotice.name'));
    });

    it('records the response with at least five characters, and closes for lack of a response with a reason', async () => {
      const { h } = detail({ may_advance: true, events: [caseEvent(1), caseEvent(2, { to_status: 'NOTICE_SENT' })] }, { status: 'NOTICE_SENT' });
      await caseLoaded();
      expect(screen.queryByTestId('move-SEND_NOTICE')).toBeNull();
      fireEvent.click(screen.getByTestId('move-RECORD_RESPONSE'));
      const form = dialog(word('vnd.move.recordResponse.name'));
      const send = within(form).getByRole('button', { name: word('vnd.move.recordResponse.name') }) as HTMLButtonElement;
      type(form, word('vnd.cases.field.response.label'), 'abc');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.cases.field.response.label'), 'Nhà thầu giải trình đã nộp đủ');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('advanceVendorRestrictionCase', expect.objectContaining({ body: { move: 'RECORD_RESPONSE', summary: 'Nhà thầu giải trình đã nộp đủ' } })));
    });

    it('says the window is still open when closing for lack of a response is refused', async () => {
      detail({ may_advance: true }, { status: 'NOTICE_SENT' }, { command: () => Promise.reject(problem(409, 'RESTRICTION_RESPONSE_WINDOW_OPEN')) });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('move-CLOSE_NO_RESPONSE'));
      const form = dialog(word('vnd.move.closeNoResponse.name'));
      type(form, word('vnd.field.reason.label'), 'Hết thời hạn phản hồi');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.move.closeNoResponse.name') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.windowOpen.text'));
    });

    it('withdraws a proposal only with a reason of ten characters', async () => {
      const { h } = detail({ may_advance: true });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('move-WITHDRAW'));
      const form = dialog(word('vnd.move.withdraw.name'));
      const send = within(form).getByRole('button', { name: word('vnd.move.withdraw.name') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'chín ký');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Thiếu căn cứ pháp lý');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('advanceVendorRestrictionCase', expect.objectContaining({ body: { move: 'WITHDRAW', reason: 'Thiếu căn cứ pháp lý' } })));
    });

    it('offers no step when the answer does not allow it, nor in a read-only workspace', async () => {
      detail({ may_advance: false });
      await caseLoaded();
      expect(screen.getByTestId('actions-none')).toBeTruthy();
      cleanup();
      detail({ may_advance: true, may_decide: true }, {}, { mode: 'READ_ONLY' });
      await caseLoaded();
      expect(screen.queryByTestId('case-actions')).toBeNull();
      expect(screen.queryByTestId('move-SEND_NOTICE')).toBeNull();
    });
  });

  describe('the decision', () => {
    const decidable = (line: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => detail({ may_decide: true, ...over }, { status: 'RESPONSE_RECEIVED', version: 8, ...line });

    it('is offered when the answer says the caller may decide', async () => {
      decidable();
      await caseLoaded();
      expect((screen.getByTestId('decide') as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId('decide-blocked')).toBeNull();
    });

    it('turns the decision off for the person who proposed the case and says why, and shows the maker and the checker', async () => {
      decidable({ proposed_by_name: 'Admin' });
      await caseLoaded();
      const button = screen.getByTestId('decide') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-describedby')).toBe('decide-blocked');
      expect(screen.getByTestId('decide-blocked').textContent).toBe(word('vnd.cases.decide.proposer.text'));
      expect(screen.getByRole('group', { name: word('ui.makerChecker.label') }).textContent).toContain('Admin');
    });

    it('decides a ban with the scope, the months inside the allowed range, the first day and the document, under the version of the case', async () => {
      const { h } = decidable();
      await caseLoaded();
      fireEvent.click(screen.getByTestId('decide'));
      const form = dialog(word('vnd.cases.decide.title'));
      const send = within(form).getByRole('button', { name: word('vnd.cases.decide.confirm') }) as HTMLButtonElement;
      expect(within(form).queryByLabelText(labelOf(word('vnd.cases.field.months.label')))).toBeNull();
      type(form, word('vnd.cases.field.decision.label'), 'BAN');
      expect(within(form).getByText(text('vnd.cases.field.months.hint', { min: 12, max: 36 }))).toBeTruthy();
      type(form, word('vnd.cases.field.scope.label'), 'PROVINCE');
      type(form, word('vnd.cases.field.months.label'), '60');
      type(form, word('vnd.cases.field.effectiveFrom.label'), '2026-12-01');
      type(form, word('vnd.cases.field.decisionDocument.label'), DOCUMENT);
      type(form, word('vnd.field.reason.label'), 'Vi phạm nghiêm trọng, đã đủ chứng cứ');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.cases.field.months.label'), '24');
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('decideVendorRestrictionCase', {
        path: { id: CASE },
        ifMatchVersion: 8,
        body: { decision: 'BAN', reason: 'Vi phạm nghiêm trọng, đã đủ chứng cứ', scope: 'PROVINCE', ban_months: 24, effective_from: '2026-12-01', decision_document_id: DOCUMENT },
        attempt: { key: expect.any(String) },
      });
    });

    it('dismisses with a reason alone', async () => {
      const { h } = decidable();
      await caseLoaded();
      fireEvent.click(screen.getByTestId('decide'));
      const form = dialog(word('vnd.cases.decide.title'));
      type(form, word('vnd.cases.field.decision.label'), 'DISMISS');
      expect(within(form).queryByLabelText(labelOf(word('vnd.cases.field.scope.label')))).toBeNull();
      type(form, word('vnd.field.reason.label'), 'Không đủ chứng cứ vi phạm');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.decide.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideVendorRestrictionCase', expect.objectContaining({ body: { decision: 'DISMISS', reason: 'Không đủ chứng cứ vi phạm' } })));
    });

    it('lets a ban of a joint venture name the members at fault, and sends none when none is chosen', async () => {
      const members = [{ contractor_id: CONTRACTOR, contractor_name: 'Thành viên A', restriction_id: null }, { contractor_id: uuid('0001', 2), contractor_name: 'Thành viên B', restriction_id: null }];
      const { h } = decidable({ subject_kind: 'JOINT_VENTURE', contractor_id: null, joint_venture_id: uuid('0013', 1) }, { members });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('decide'));
      const form = dialog(word('vnd.cases.decide.title'));
      type(form, word('vnd.cases.field.decision.label'), 'BAN');
      expect(within(form).getByLabelText('Thành viên B')).toBeTruthy();
      type(form, word('vnd.cases.field.scope.label'), 'TENANT');
      type(form, word('vnd.cases.field.months.label'), '12');
      type(form, word('vnd.cases.field.effectiveFrom.label'), '2026-12-01');
      type(form, word('vnd.cases.field.decisionDocument.label'), DOCUMENT);
      type(form, word('vnd.field.reason.label'), 'Liên danh vi phạm nghiêm trọng');
      fireEvent.click(within(form).getByLabelText('Thành viên B'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.decide.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideVendorRestrictionCase', expect.objectContaining({ body: expect.objectContaining({ culpable_member_ids: [uuid('0001', 2)] }) })));
    });

    it('says in the dialog that the proposer may not decide when the server refuses with SELF_APPROVAL_DENIED', async () => {
      decidable({}, {});
      cleanup();
      detail({ may_decide: true }, { status: 'RESPONSE_RECEIVED' }, { command: () => Promise.reject(problem(403, 'SELF_APPROVAL_DENIED')) });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('decide'));
      const form = dialog(word('vnd.cases.decide.title'));
      type(form, word('vnd.cases.field.decision.label'), 'DISMISS');
      type(form, word('vnd.field.reason.label'), 'Không đủ chứng cứ vi phạm');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.decide.confirm') }));
      const alert = await within(form).findByRole('alert');
      expect(alert.textContent).toBe(word('vnd.error.selfApproval.text'));
      expect(alert.getAttribute('data-code')).toBe('SELF_APPROVAL_DENIED');
    });

    it('says the range of the months when the server refuses the period, and a changed version with a way to read again', async () => {
      let attempt = 0;
      detail({ may_decide: true }, { status: 'RESPONSE_RECEIVED' }, { command: () => Promise.reject(++attempt === 1 ? problem(422, 'RESTRICTION_BAN_PERIOD_INVALID', undefined, { min_months: 12, max_months: 36 }) : problem(409, 'VERSION_CONFLICT')) });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('decide'));
      const form = dialog(word('vnd.cases.decide.title'));
      type(form, word('vnd.cases.field.decision.label'), 'BAN');
      type(form, word('vnd.cases.field.scope.label'), 'TENANT');
      type(form, word('vnd.cases.field.months.label'), '12');
      type(form, word('vnd.cases.field.effectiveFrom.label'), '2026-12-01');
      type(form, word('vnd.cases.field.decisionDocument.label'), DOCUMENT);
      type(form, word('vnd.field.reason.label'), 'Vi phạm nghiêm trọng, đã đủ chứng cứ');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.decide.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(text('vnd.error.banPeriod.text', { min: 12, max: 36 }));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.decide.confirm') }));
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe(word('vnd.error.conflict.text')));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });
  });

  describe('putting into effect and lifting', () => {
    it('puts the decision into effect under the version of the case, naming how many members are reached', async () => {
      const { h } = detail({ may_put_into_effect: true }, { status: 'DECIDED', decision: 'BAN', version: 11 });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('effect'));
      const form = dialog(word('vnd.cases.effect.title'));
      expect(form.textContent).toContain(word('vnd.cases.members.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.effect.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('putVendorRestrictionIntoEffect', { path: { id: CASE }, ifMatchVersion: 11, attempt: { key: expect.any(String) } }));
    });

    it('lifts the restriction with a reason of ten characters and, if there is one, the document', async () => {
      const { h } = detail({ may_lift: true }, { status: 'EFFECTIVE', version: 12 });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('lift'));
      const form = dialog(word('vnd.cases.lift.title'));
      const send = within(form).getByRole('button', { name: word('vnd.cases.lift.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'ngắn');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Khiếu nại thành công');
      type(form, word('vnd.cases.field.liftDocument.label'), DOCUMENT);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('liftVendorRestrictionCase', { path: { id: CASE }, ifMatchVersion: 12, body: { reason: 'Khiếu nại thành công', document_id: DOCUMENT }, attempt: { key: expect.any(String) } }));
    });

    it('says the decision is not in effect yet when lifting is refused for it', async () => {
      detail({ may_lift: true }, { status: 'DECIDED' }, { command: () => Promise.reject(problem(409, 'RESTRICTION_NOT_YET_EFFECTIVE')) });
      await caseLoaded();
      fireEvent.click(screen.getByTestId('lift'));
      const form = dialog(word('vnd.cases.lift.title'));
      type(form, word('vnd.field.reason.label'), 'Khiếu nại thành công');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.cases.lift.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.notYetEffective.text'));
    });
  });

  describe('states', () => {
    it('LOADING, ERROR with retry, FORBIDDEN, EMPTY for a case that is not there', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<CasesScreen route={route} />, pending, { permissions: ALL, path: `/vnd/vnd-03?case=${CASE}` });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      detail({}, {}, { failing: { getVendorRestrictionCase: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await caseLoaded();
      cleanup();
      detail({}, {}, { failing: { getVendorRestrictionCase: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
      cleanup();
      detail({}, {}, { failing: { getVendorRestrictionCase: { error: problem(404, 'RESOURCE_NOT_FOUND'), times: 9 } } });
      expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    });

    it('STALE: keeps the last reading of the case when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { getVendorRestrictionCase: () => (++calls === 1 ? caseDetail(caseLine(1)) : problem(500, 'INTERNAL_ERROR')) } };
      const mounted = mount(<CasesScreen route={route} />, client(world), { permissions: ALL, path: `/vnd/vnd-03?case=${CASE}` });
      await caseLoaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(screen.getByTestId('case-facts')).toBeTruthy();
    });

    it('links back to the list', async () => {
      detail();
      await caseLoaded();
      expect(screen.getByRole('link', { name: word('vnd.cases.back.action') }).getAttribute('href')).toBe('/vnd/vnd-03');
    });
  });
});
