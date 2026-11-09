import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';

import { SessionContext } from '../../../session/SessionContext';
import { TENANT } from '../../bid/test-support';
import PortalCertificatesScreen from './PortalCertificatesScreen';
import PortalEvaluationsScreen from './PortalEvaluationsScreen';
import PortalHomeScreen from './PortalHomeScreen';
import PortalRequestsScreen from './PortalRequestsScreen';
import { PortalFrame } from './portal-frame';
import { FORBIDDEN_WORDS, RECONFIRM_STATES } from './portal-model';
import {
  AS_OF,
  CONTRACTOR,
  DECLARATION,
  DOCUMENT,
  GUEST,
  GUEST_READER,
  POISON,
  attachmentPage,
  client,
  mount,
  portalAction,
  portalAttachment,
  portalEvaluation,
  portalHome,
  portalPlan,
  portalProfile,
  portalRequest,
  qualificationList,
  requestPage,
  routeOf,
  uuid,
} from './test/portal-test-support';
import type { World } from './test/portal-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const sent = (): { attempt: { key: unknown } } => ({ attempt: { key: expect.any(String) } });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  failing?: World['failing'];
}

function open(screenElement: ReactElement, answers: World['answers'], options: Options = {}) {
  const world: World = { answers, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(screenElement, h, { permissions: options.permissions ?? GUEST, path: '/vnd/vnd-16', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const HOME_ANSWERS = (over: Record<string, unknown> = {}) => ({ getPortalHome: portalHome(over) });

describe('the layout of the portal (layout rules 1 to 3)', () => {
  it('shows the name and tax code of the contractor, the one navigation of five destinations, and the scope line', async () => {
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS());
    const identity = await screen.findByTestId('portal-identity');
    await waitFor(() => expect(identity.textContent).toContain('Công ty nhà thầu 1'));
    expect(identity.textContent).toContain(text('vnp.layout.tax.text', { tax: '0101234561' }));
    expect(screen.getByTestId('portal-scope').textContent).toBe(word('vnp.layout.scope.text'));
    const nav = screen.getByTestId('portal-nav');
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/vnd/vnd-16', '/vnd/vnd-17', '/vnd/vnd-18', '/vnd/vnd-19', '/vnd/vnd-24']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.getAttribute('aria-current')).toBeNull();
  });

  it('draws only the named fields: whatever else a payload carries never reaches the page', async () => {
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS({ ...POISON, profile: portalProfile({ ...POISON }) }));
    await screen.findByTestId('profile-facts');
    const page = document.body.textContent ?? '';
    for (const value of ['POISON-RED-FLAG', 'POISON-RISK-GRADE', 'POISON-LEAD', 'POISON-SCREENING', 'POISON-OTHER', 'POISON-INVESTIGATION']) expect(page).not.toContain(value);
    for (const forbidden of FORBIDDEN_WORDS) expect(page.toLowerCase()).not.toContain(forbidden);
  });

  it('shows the reduced frame to a contractor: the product and the workspace, the routed screen, and no sidebar, bell or search', () => {
    const session = { tenant: TENANT, tenants: [TENANT], user: { displayName: 'Nhà thầu', initials: 'NT' }, access: undefined, switchTenant: () => undefined, getSession: () => Promise.resolve({ token: 't' }), permissions: GUEST };
    render(
      <SessionContext.Provider value={session as never}>
        <MemoryRouter initialEntries={['/vnd/vnd-16']}>
          <Routes>
            <Route element={<PortalFrame />}>
              <Route path="/vnd/vnd-16" element={<p>routed screen</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    expect(screen.getByTestId('portal-frame')).toBeTruthy();
    expect(screen.getByText('routed screen')).toBeTruthy();
    expect(screen.getByText(word('vnp.frame.product.text'))).toBeTruthy();
    expect(screen.getByRole('button', { name: translator.t('shell.help.open.label') })).toBeTruthy();
    expect(document.querySelector('aside, .sidebar, [role="search"], [aria-label*="Cần xử lý"]')).toBeNull();
  });
});

describe('PortalHomeScreen (VND-16)', () => {
  it('lists the facts of the profile with the words of the screen, a fact that is empty as not on file, and the counts as links', async () => {
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS({ profile: portalProfile({ phone: null }) }));
    await screen.findByTestId('profile-facts');
    expect(screen.getByTestId('fact-legal_rep_name').textContent).toContain('Nguyễn Văn An');
    expect(screen.getByTestId('fact-phone').textContent).toContain(word('vnp.home.profile.empty.text'));
    expect(screen.getByTestId('fact-ownership_declaration').textContent).toContain(word('vnp.ownership.ownersListed.name'));
    expect(screen.getByTestId('count-requests').getAttribute('href')).toBe('/vnd/vnd-17');
    expect(screen.getByTestId('count-requests').textContent).toContain('2');
    expect(screen.getByTestId('count-requests').textContent).toContain(text('vnp.home.counts.overdue.text', { count: 1 }));
    expect(screen.getByTestId('count-certificates').getAttribute('href')).toBe('/vnd/vnd-18');
    expect(screen.getByTestId('count-plans').getAttribute('href')).toBe('/vnd/vnd-19');
  });

  it('says every state of the confirmation in words and asks for it in every state but the current one', async () => {
    for (const state of RECONFIRM_STATES) {
      cleanup();
      open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS({ reconfirmation: { ...portalHome().reconfirmation, state } }));
      await screen.findByTestId('reconfirm-facts');
      const pill = document.querySelector(`[data-state="${state}"]`);
      expect(pill?.textContent).toContain(word(`vnp.reconfirmState.${state === 'DUE_SOON' ? 'dueSoon' : state.toLowerCase()}.name`));
      expect(screen.queryByTestId('reconfirm') !== null).toBe(state !== 'CURRENT');
    }
  });

  it('confirms the profile: reads the declaration, needs the tick, sends the version that was shown, and ends in a receipt', async () => {
    const h = open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS());
    fireEvent.click(await screen.findByTestId('reconfirm'));
    const box = dialog();
    expect(within(box).getByTestId('declaration-text').textContent).toBe(DECLARATION);
    const confirm = within(box).getByRole('button', { name: word('vnp.reconfirm.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(box).getByLabelText(labelOf(word('vnp.reconfirm.field.accepted.label'))));
    type(box, word('vnp.reconfirm.field.changes.label'), 'Đổi người đại diện');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('confirmPortalReconfirmation', { body: { declaration_version: 'V1', accepted: true, changes_note: 'Đổi người đại diện' }, ...sent() }));
    expect((await screen.findByTestId('receipt')).textContent).toContain('Đã ghi xác nhận lại hồ sơ');
  });

  it('reads the declaration again when it changed meanwhile (409 RECONFIRMATION_DECLARATION_STALE)', async () => {
    const h = open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS(), {
      command: () => problem(409, 'RECONFIRMATION_DECLARATION_STALE'),
    });
    fireEvent.click(await screen.findByTestId('reconfirm'));
    const box = dialog();
    fireEvent.click(within(box).getByLabelText(labelOf(word('vnp.reconfirm.field.accepted.label'))));
    const readsBefore = h.read.mock.calls.filter(([operation]) => operation === 'getPortalHome').length;
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.reconfirm.confirm.action') }));
    const failure = await within(box).findByTestId('dialog-error');
    expect(failure.textContent).toBe(word('vnp.error.declarationStale.text'));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getPortalHome').length).toBeGreaterThan(readsBefore));
  });

  it('offers no command in a read-only workspace or without the right to reconfirm', async () => {
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS(), { mode: 'READ_ONLY' });
    await screen.findByTestId('reconfirm-facts');
    expect(screen.queryByTestId('reconfirm')).toBeNull();
    cleanup();
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS({ actions: { respond: true, certificate: true, reconfirm: false, remediation: true } }));
    await screen.findByTestId('reconfirm-facts');
    expect(screen.queryByTestId('reconfirm')).toBeNull();
  });

  it('says the area is for contractor accounts when the server refuses it (403 PORTAL_CONTRACTOR_REQUIRED)', async () => {
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, { getPortalHome: problem(403, 'PORTAL_CONTRACTOR_REQUIRED') });
    const denied = await screen.findByTestId('portal-denied');
    expect(denied.textContent).toContain(word('vnp.denied.title.text'));
    expect(denied.textContent).toContain(word('vnp.denied.body.text'));
    expect(screen.queryByTestId('profile-facts')).toBeNull();
  });

  it('says loading, error with a retry, and a stale answer', async () => {
    open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, { getPortalHome: new Promise(() => undefined) as never });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    const h = open(<PortalHomeScreen route={routeOf('VND-16', 'FR-VND-16')} />, HOME_ANSWERS(), { failing: { getPortalHome: { error: new Error('boom'), times: 1 } } });
    const retry = await screen.findByRole('button', { name: word('states.retry.action') });
    fireEvent.click(retry);
    await screen.findByTestId('profile-facts');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getPortalHome').length).toBeGreaterThanOrEqual(2);
  });
});

describe('PortalRequestsScreen (VND-17)', () => {
  const route = routeOf('VND-17', 'FR-VND-17');
  const answers = (items: Array<Record<string, unknown>>) => ({ ...HOME_ANSWERS(), listPortalRequests: requestPage(items), listPortalAttachments: attachmentPage([portalAttachment(1, { document_id: DOCUMENT })]) });

  it('shows the kind, the body, the time limit with the clock and the status of each request', async () => {
    open(<PortalRequestsScreen route={route} />, answers([portalRequest(1), portalRequest(2, { kind: 'EVALUATION_RESPONSE', clock: 'OVERDUE', due_at: '2026-11-05T02:00:00.000Z' })]));
    const list = await screen.findByTestId('request-list');
    const first = list.querySelector(`[data-request-id="${uuid('0040', 1)}"]`) as HTMLElement;
    expect(first.textContent).toContain('Cung cấp báo cáo tài chính 1');
    expect(first.textContent).toContain(word('vnp.requestKind.information.name'));
    expect(first.textContent).toContain(word('vnp.requestClock.onTime.name'));
    expect(first.textContent).toContain(word('vnp.requestStatus.open.name'));
    const second = list.querySelector(`[data-request-id="${uuid('0040', 2)}"]`) as HTMLElement;
    expect(second.textContent).toContain(word('vnp.requestClock.overdue.name'));
    expect(second.textContent).toContain(word('vnp.requestKind.evaluationResponse.name'));
  });

  it('answers a request with the version that was read, and a receipt', async () => {
    const h = open(<PortalRequestsScreen route={route} />, answers([portalRequest(1)]));
    fireEvent.click(await screen.findByTestId('answer'));
    const box = dialog();
    expect(within(box).queryByTestId('late-note')).toBeNull();
    const confirm = within(box).getByRole('button', { name: word('vnp.answer.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type(box, word('vnp.answer.field.text.label'), 'Đính kèm báo cáo năm 2025');
    await waitFor(() => expect(within(box).getByRole('option', { name: /Bao cao tai chinh 1/ })).toBeTruthy());
    type(box, word('vnp.answer.field.document.label'), DOCUMENT);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('respondPortalRequest', { path: { id: uuid('0040', 1) }, ifMatchVersion: 3, body: { text: 'Đính kèm báo cáo năm 2025', document_id: DOCUMENT }, ...sent() }),
    );
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnp.answer.title.text'));
  });

  it('still takes an answer after the time limit and says it will be marked late; an answer given late is labelled late', async () => {
    open(<PortalRequestsScreen route={route} />, answers([portalRequest(1, { clock: 'OVERDUE' }), portalRequest(2, { status: 'RESPONDED', clock: 'ANSWERED_LATE', response_text: 'Gửi muộn', responded_at: '2026-11-22T02:00:00.000Z', response_late: true })]));
    await screen.findByTestId('request-list');
    const late = document.querySelector(`[data-request-id="${uuid('0040', 2)}"]`) as HTMLElement;
    expect(within(late).getByTestId('answer-text').textContent).toContain('Gửi muộn');
    expect(within(late).getByTestId('late-label').textContent).toContain(word('vnp.requests.late.label'));
    expect(within(late).queryByTestId('answer')).toBeNull();
    fireEvent.click(within(document.querySelector(`[data-request-id="${uuid('0040', 1)}"]`) as HTMLElement).getByTestId('answer'));
    expect(within(dialog()).getByTestId('late-note').textContent).toBe(word('vnp.answer.late.note'));
  });

  it('shows what staff said when a request was sent back, with the round, and offers the answer again', async () => {
    open(<PortalRequestsScreen route={route} />, answers([portalRequest(1, { round: 2, review_note: 'Thiếu trang ký', response_text: 'Bản đầu' })]));
    const returned = await screen.findByTestId('returned-note');
    expect(returned.textContent).toContain(text('vnp.requests.returned.text', { round: 2 }));
    expect(returned.textContent).toContain('Thiếu trang ký');
    expect(screen.getByTestId('answer').textContent).toBe(word('vnp.requests.answerAgain.action'));
  });

  it('puts a certificate on file from a request for one and links it to the request', async () => {
    const h = open(<PortalRequestsScreen route={route} />, answers([portalRequest(1, { kind: 'CERTIFICATE_UPLOAD' })]));
    fireEvent.click(await screen.findByTestId('upload-certificate'));
    const box = dialog();
    type(box, word('vnd.certs.field.number.label'), 'ATLD-9');
    type(box, word('vnd.certs.field.issuer.label'), 'Sở Lao động');
    type(box, word('vnd.certs.field.issued.label'), '2026-01-01');
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnd.certs.field.kind.label'))), { target: { value: 'SAFETY_CERTIFICATE' } });
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.certificate.add.confirm') }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('submitPortalQualification', { body: { kind: 'SAFETY_CERTIFICATE', certificate_no: 'ATLD-9', issuer: 'Sở Lao động', issued_on: '2026-01-01', request_id: uuid('0040', 1) }, ...sent() }),
    );
  });

  it('filters by status, says when nothing is asked, and offers no answer without the right to answer', async () => {
    const h = open(<PortalRequestsScreen route={route} />, answers([portalRequest(1)]), { permissions: GUEST_READER });
    await screen.findByTestId('request-list');
    expect(screen.queryByTestId('answer')).toBeNull();
    fireEvent.change(screen.getByLabelText(word('vnp.requests.filter.status.label')), { target: { value: 'ACCEPTED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listPortalRequests', { query: { status: 'ACCEPTED' } }));
    cleanup();
    open(<PortalRequestsScreen route={route} />, answers([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });
});

describe('PortalCertificatesScreen (VND-18)', () => {
  const route = routeOf('VND-18', 'FR-VND-18');
  const answers = (over: Record<string, unknown> = {}) => ({ ...HOME_ANSWERS(), listPortalQualifications: qualificationList(over) });

  it('lists the certificates and the key staff with the state, the days left and whether they were checked', async () => {
    open(<PortalCertificatesScreen route={route} />, answers());
    await screen.findAllByText(/CCNL-1/);
    const first = document.querySelector(`tr[data-qualification-id="${uuid('0006', 1)}"]`) as HTMLElement;
    expect(first.textContent).toContain(word('vnd.kind.constructionActivity.name'));
    expect(first.textContent).toContain(word('vnp.certs.verified.yes'));
    const second = document.querySelector(`tr[data-qualification-id="${uuid('0006', 2)}"]`) as HTMLElement;
    expect(second.textContent).toContain(word('vnp.certs.verified.no'));
    expect(second.textContent).toContain(word('vnd.certState.expiringSecond.name'));
    const staff = document.querySelector(`tr[data-staff-id="${uuid('0007', 1)}"]`) as HTMLElement;
    expect(staff.textContent).toContain('Lý Văn Dũng 1');
    expect(staff.textContent).toContain(word('vnp.certs.verified.no'));
  });

  it('adds a certificate of the contractor itself, without naming a contractor in the request', async () => {
    const h = open(<PortalCertificatesScreen route={route} />, answers());
    fireEvent.click(await screen.findByTestId('add-certificate'));
    const box = dialog();
    type(box, word('vnd.certs.field.number.label'), 'TK-77');
    type(box, word('vnd.certs.field.issuer.label'), 'Sở Xây dựng');
    type(box, word('vnd.certs.field.issued.label'), '2025-03-01');
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnd.certs.field.kind.label'))), { target: { value: 'DESIGN_CONSULTING' } });
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.certificate.add.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitPortalQualification', { body: { kind: 'DESIGN_CONSULTING', certificate_no: 'TK-77', issuer: 'Sở Xây dựng', issued_on: '2025-03-01' }, ...sent() }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnp.certificate.add.title'));
  });

  it('says plainly when nothing is on file and hides the add button without the right', async () => {
    open(<PortalCertificatesScreen route={route} />, answers({ qualifications: [], key_staff: [] }), { permissions: GUEST_READER });
    expect((await screen.findByTestId('certificates-empty')).textContent).toBe(word('vnp.certs.certificates.empty.text'));
    expect(screen.getByTestId('staff-empty')).toBeTruthy();
    expect(screen.queryByTestId('add-certificate')).toBeNull();
  });
});

describe('PortalEvaluationsScreen (VND-19)', () => {
  const route = routeOf('VND-19', 'FR-VND-19');
  const open_ = (over: Record<string, unknown> = {}, options: Options = {}) =>
    open(
      <PortalEvaluationsScreen route={route} />,
      {
        ...HOME_ANSWERS(),
        listPortalEvaluations: { items: [portalEvaluation(1, { open_request_id: uuid('0040', 7) }), portalEvaluation(2)], as_of: AS_OF },
        listPortalRequests: requestPage([portalRequest(7, { kind: 'EVALUATION_RESPONSE', title: 'Phản hồi đánh giá quý 1' })]),
        listPortalRemediationPlans: { items: [portalPlan(1)], as_of: AS_OF },
        ...over,
      },
      options,
    );

  it('shows the approved evaluations with the five scores, the rating in words and the remarks', async () => {
    open_();
    await screen.findByText('HD-1');
    const row = document.querySelector(`tr[data-evaluation-id="${uuid('0041', 1)}"]`) as HTMLElement;
    expect(row.textContent).toContain('71.50');
    expect(row.textContent).toContain(text('vnp.evaluations.scores.text', { quality: 70, schedule: 65, safety: 80, cooperation: 75, financial: 68 }));
    expect(row.textContent).toContain(word('vnp.rating.fair.name'));
    expect(row.textContent).toContain('Tiến độ chậm ở hạng mục móng');
  });

  it('answers an evaluation through the open request that asks for it, and only an evaluation that has one', async () => {
    const h = open_();
    await screen.findByText('HD-1');
    expect(screen.getAllByTestId('respond-evaluation')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('respond-evaluation'));
    const box = dialog();
    expect(within(box).getByText('Phản hồi đánh giá quý 1')).toBeTruthy();
    type(box, word('vnp.answer.field.text.label'), 'Chúng tôi đã bổ sung nhân sự');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.answer.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('respondPortalRequest', { path: { id: uuid('0040', 7) }, ifMatchVersion: 3, body: { text: 'Chúng tôi đã bổ sung nhân sự' }, ...sent() }));
  });

  it('agrees to a plan and reports an action as done once the plan is in progress', async () => {
    const h = open_();
    await screen.findByTestId('agree-plan');
    expect(screen.queryByTestId('mark-done')).toBeNull();
    fireEvent.click(screen.getByTestId('agree-plan'));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('vnp.plan.agree.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('agreePortalRemediationPlan', { path: { id: uuid('0044', 1) }, ifMatchVersion: 5, ...sent() }));
    cleanup();
    const g = open_({ listPortalRemediationPlans: { items: [portalPlan(1, { status: 'IN_PROGRESS', actions: [portalAction(1), portalAction(2, { status: 'DONE', done_at: AS_OF })] })], as_of: AS_OF } });
    await screen.findByTestId('mark-done');
    expect(screen.getAllByTestId('mark-done')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('mark-done'));
    const box = dialog();
    type(box, word('vnp.plan.done.field.label'), 'Đã có hai giám sát mới');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.plan.done.confirm') }));
    await waitFor(() => expect(g.command).toHaveBeenCalledWith('markPortalRemediationActionDone', { path: { id: uuid('0043', 1) }, ifMatchVersion: 2, body: { note: 'Đã có hai giám sát mới' }, ...sent() }));
  });

  it('marks the actions that are past their day and says how many the contractor still owes', async () => {
    open_();
    const plan = (await screen.findByLabelText('Khắc phục tiến độ 1')) as HTMLElement;
    expect(plan.textContent).toContain(text('vnp.plans.owed.text', { count: 2 }));
    expect(plan.textContent).toContain(word('vnp.plans.overdue.label'));
    expect(plan.textContent).toContain(word('vnp.planStatus.proposed.name'));
  });

  it('keeps the evaluations when the plans cannot be read, and says so with a retry', async () => {
    const h = open_({}, { failing: { listPortalRemediationPlans: { error: new Error('boom'), times: 1 } } });
    await screen.findByText('HD-1');
    const notice = await screen.findByTestId('partial-notice');
    expect(notice.textContent).toContain(word('vnp.plans.partial.text'));
    fireEvent.click(within(notice).getByRole('button', { name: word('states.retry.action') }));
    await screen.findByLabelText('Khắc phục tiến độ 1');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'listPortalRemediationPlans').length).toBeGreaterThanOrEqual(2);
  });

  it('says plainly when there is no evaluation and no plan, and never shows a contractor id of its own', async () => {
    open_({ listPortalEvaluations: { items: [], as_of: AS_OF }, listPortalRemediationPlans: { items: [], as_of: AS_OF } });
    expect((await screen.findByTestId('evaluations-empty')).textContent).toBe(word('vnp.evaluations.empty.text'));
    expect(screen.getByTestId('plans-empty')).toBeTruthy();
    expect(document.body.textContent).not.toContain(CONTRACTOR);
  });
});
