import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ReportDetailScreen from './ReportDetailScreen';
import { CORRECTOR, MAKER, READER, REPORT, REVIEWER, WITHDRAWER, client, fileRecord, mount, progressRecord, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-07', 'FR-DIS-07');
const PATH = `/dis/dis-07?report=${REPORT}`;
const DECIDED_BY = '00000000-0000-4000-8000-0000000000bb';

afterEach(cleanup);

const open = (record: Record<string, unknown>, options: { permissions?: readonly string[] | undefined; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) => {
  const h = client(world({ details: { [REPORT]: record } }), options.command ?? (() => ({ status: 'ACCEPTED', resource_version: 4 })));
  mount(<ReportDetailScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : REVIEWER, path: PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const submitted = (extra: Record<string, unknown> = {}) => reportRecord({ status: 'SUBMITTED', version: 2, submitted_by: DECIDED_BY, review: null, ...extra });
const returned = reportRecord({
  status: 'RETURNED',
  version: 3,
  returned_reason: 'The CTMTQG cell is wrong.',
  review: null,
  decisions: [
    {
      id: '00000000-0000-4000-8000-0000000000d1',
      decision: 'RETURNED',
      reason: 'The CTMTQG cell is wrong.',
      evidence_ids: [],
      return_items: ['Fix the CTMTQG cell', 'Explain the fall'],
      due_at: '2027-01-20T16:59:59.000Z',
      decided_by: DECIDED_BY,
      decided_at: '2027-01-12T03:00:00.000Z',
    },
  ],
});
const bodyOf = (h: { command: { mock: { calls: unknown[][] } } }) => h.command.mock.calls[0]?.[1] as { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number };

describe('DIS-07 report detail and the decision of the reviewer', () => {
  it('shows the report as it was handed in: the six cells with the CTMTQG apart, the total that is the sum of the cells, the status and whether it is the current revision', async () => {
    open(submitted());
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reportDetail.page.title'] })).toBeTruthy();
    expect((await screen.findByTestId('detail-total')).textContent).toBe('420.000.000');
    expect(screen.getByTestId('detail-ctmtqg').textContent).toBe('40.000.000');
    expect(screen.getByTestId('fact-status').textContent).toBe(vi_['dis.reportStatus.submitted']);
    expect(screen.getByTestId('current-mark').textContent).toBe(vi_['dis.reportDetail.current.no.text']);
    expect(screen.getByTestId('decisions-none').textContent).toBe(vi_['dis.reportDecision.history.none.text']);
  });

  it('reads all of what was handed in: the explanation of a fall, the volumes, the registration for next month, the notes and the files', async () => {
    open(
      submitted({
        negative_delta_explanation: 'The payment was returned by the Treasury.',
        progress: progressRecord(),
        narrative: { results: 'The bridge deck was poured.', causes: null, solutions: 'Add a second shift.', proposals: null, linked_issue_ids: [] },
        attachments: [fileRecord(1)],
      }),
      { permissions: READER },
    );
    expect((await screen.findByTestId('detail-explanation')).textContent).toBe('The payment was returned by the Treasury.');
    const volumes = screen.getByTestId('detail-volumes');
    expect(within(volumes).getByText('300.000.000')).toBeTruthy();
    expect(within(volumes).getByText('37.50')).toBeTruthy();
    expect(screen.getByTestId('detail-registration').textContent).toBe('5.000.000 đồng, trong đó CTMTQG 0 đồng.');
    const notes = screen.getByTestId('detail-notes');
    expect(within(notes).getByText('The bridge deck was poured.')).toBeTruthy();
    expect(within(notes).getByText('Add a second shift.')).toBeTruthy();
    expect(within(notes).queryByText(vi_['dis.review.notes.causes.label'])).toBeNull();
    expect(within(screen.getByTestId('detail-files')).getByText(/voucher-1\.pdf/)).toBeTruthy();
  });

  it('says so when the report has no volumes, no notes and no files', async () => {
    open(submitted(), { permissions: READER });
    expect((await screen.findByTestId('detail-volumes-none')).textContent).toBe(vi_['dis.reportDetail.volumes.none.text']);
    expect(screen.getByTestId('detail-notes-none').textContent).toBe(vi_['dis.reportDetail.notes.none.text']);
    expect(screen.getByTestId('detail-files-none').textContent).toBe(vi_['dis.review.files.none.text']);
    expect(screen.queryByTestId('detail-explanation')).toBeNull();
  });

  it('AC-ST-DIS-006-1: a reviewer accepts with a reason: the command carries the version the screen showed and an empty list of evidence', async () => {
    const user = userEvent.setup();
    const h = open(submitted());
    const form = await screen.findByTestId('decision-form');
    expect((within(form).getByLabelText(vi_['dis.reportDecision.kind.label']) as HTMLSelectElement).value).toBe('approve');
    expect(within(form).queryByLabelText(vi_['dis.reportDecision.items.label'])).toBeNull();
    await user.type(within(form).getByLabelText(vi_['dis.reportDecision.reason.label']), 'The figures agree with the Treasury.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportDecision.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_decision');
    expect(bodyOf(h)).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 2, body: { decision: 'approve', reason: 'The figures agree with the Treasury.', evidence_ids: [] } });
  });

  it('AC-ST-DIS-006-3: a return needs its items and a day: nothing is sent until they are there, then the items and the end of the day go with it', async () => {
    const user = userEvent.setup();
    const h = open(submitted());
    const form = await screen.findByTestId('decision-form');
    await user.selectOptions(within(form).getByLabelText(vi_['dis.reportDecision.kind.label']), 'return');
    await user.type(within(form).getByLabelText(vi_['dis.reportDecision.reason.label']), 'The CTMTQG cell is wrong.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportDecision.submit.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form).getByText(vi_['dis.reportDecision.problem.required'])).toBeTruthy();
    expect(within(form).getByText(vi_['dis.reportDecision.problem.dueRequired'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['dis.reportDecision.items.label']), 'Fix the CTMTQG cell{Enter}Explain the fall');
    fireEvent.change(within(form).getByLabelText(vi_['dis.reportDecision.due.label']), { target: { value: '2099-01-20' } });
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportDecision.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(bodyOf(h).body).toEqual({ decision: 'return', reason: 'The CTMTQG cell is wrong.', evidence_ids: [], return_items: ['Fix the CTMTQG cell', 'Explain the fall'], due_at: '2099-01-20T16:59:59.000Z' });
  });

  it('AC-ST-DIS-006-1: tells in words that the person who handed the report in does not decide on it, and keeps what was typed', async () => {
    const user = userEvent.setup();
    open(submitted(), { command: () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }) });
    const form = await screen.findByTestId('decision-form');
    await user.type(within(form).getByLabelText(vi_['dis.reportDecision.reason.label']), 'The figures agree with the Treasury.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportDecision.submit.action'] }));
    expect((await screen.findByTestId('decision-refusal')).textContent).toBe(vi_['dis.reportProblem.selfApproval']);
    expect((within(form).getByLabelText(vi_['dis.reportDecision.reason.label']) as HTMLTextAreaElement).value).toBe('The figures agree with the Treasury.');
  });

  it('tells a report that moved under the reviewer, and one that the server says is not in the state for a decision', async () => {
    const user = userEvent.setup();
    open(submitted(), { command: () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }) });
    const form = await screen.findByTestId('decision-form');
    await user.type(within(form).getByLabelText(vi_['dis.reportDecision.reason.label']), 'The figures agree.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportDecision.submit.action'] }));
    expect((await screen.findByTestId('decision-refusal')).textContent).toBe(vi_['dis.reportProblem.versionConflict']);
  });

  it('shows the maker what a return asked to be fixed and by when, with the way to correct it and to the history', async () => {
    open(returned, { permissions: CORRECTOR });
    const sentBack = await screen.findByTestId('sent-back');
    expect(within(sentBack).getByText('Fix the CTMTQG cell')).toBeTruthy();
    expect(within(sentBack).getByText('Explain the fall')).toBeTruthy();
    expect(sentBack.textContent).toContain('20/01/2027 23:59');
    expect(screen.getByRole('link', { name: vi_['dis.reportDetail.correct.action'] }).getAttribute('href')).toBe(`/dis/dis-08?report=${REPORT}`);
    expect(screen.getAllByRole('link', { name: vi_['dis.reportDetail.history.link'] })[0]?.getAttribute('href')).toBe(`/dis/dis-11?report=${REPORT}`);
    expect(screen.queryByTestId('decision-form')).toBeNull();
    expect(within(screen.getByTestId('decisions')).getAllByRole('listitem')[0]?.getAttribute('data-decision')).toBe('RETURNED');
  });

  it('offers the reviewer to ask the amendment of the accepted report that is the current one, with the reason only', async () => {
    const user = userEvent.setup();
    const h = open(reportRecord({ status: 'ACCEPTED', is_current: true, version: 3, accepted_by: DECIDED_BY, accepted_at: '2027-01-12T03:00:00.000Z', submitted_by: '00000000-0000-4000-8000-0000000000aa', review: null }), {
      command: () => ({ status: 'AMENDMENT_REQUESTED', resource_version: 4 }),
    });
    expect((await screen.findByTestId('current-mark')).textContent).toBe(vi_['dis.reportDetail.current.yes.text']);
    const form = screen.getByTestId('decision-form');
    expect(within(form).queryByRole('option', { name: vi_['dis.reportDecision.choice.approve'] })).toBeNull();
    await user.type(within(form).getByLabelText(vi_['dis.reportDecision.reason.label']), 'The Treasury corrected a payment.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportDecision.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(bodyOf(h).body).toEqual({ decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] });
  });

  it('AC-ST-DIS-007-3: leads the maker who may withdraw to the confirmation, for a report that was handed in and for no other', async () => {
    open(submitted(), { permissions: WITHDRAWER });
    expect((await screen.findByTestId('withdraw-link')).getAttribute('href')).toBe(`/dis/dis-09?report=${REPORT}`);
    cleanup();
    open(submitted(), { permissions: MAKER });
    await screen.findByTestId('detail-total');
    expect(screen.queryByTestId('withdraw-link')).toBeNull();
    cleanup();
    open(reportRecord({ status: 'ACCEPTED', is_current: true, review: null }), { permissions: WITHDRAWER });
    await screen.findByTestId('detail-total');
    expect(screen.queryByTestId('withdraw-link')).toBeNull();
  });

  it('says which revision a correction corrects and why, with the way to the history', async () => {
    open(reportRecord({ revision: 2, status: 'SUBMITTED', submitted_by: DECIDED_BY, supersedes_id: '00000000-0000-4000-8000-0000000000e1', amendment_reason: 'The Treasury corrected a payment of March.', review: null }), { permissions: READER });
    const lineage = await screen.findByTestId('lineage');
    expect(lineage.textContent).toContain('The Treasury corrected a payment of March.');
    expect(within(lineage).getByRole('link', { name: vi_['dis.reportDetail.history.link'] }).getAttribute('href')).toBe(`/dis/dis-11?report=${REPORT}`);
  });

  it('gives a reader and a read-only tenant no button, and a maker without the right to review no form', async () => {
    for (const options of [{ permissions: READER }, { permissions: REVIEWER, mode: 'READ_ONLY' as const }, { permissions: MAKER }]) {
      open(submitted(), options);
      await screen.findByTestId('detail-total');
      expect(screen.queryByTestId('decision-form')).toBeNull();
      expect(screen.queryByRole('link', { name: vi_['dis.reportDetail.correct.action'] })).toBeNull();
      cleanup();
    }
  });

  it('chooses a report first: with none named there is nothing to read, and one that is not there is told as empty', async () => {
    const h = client(world());
    mount(<ReportDetailScreen route={ROUTE} />, h, { permissions: REVIEWER, path: '/dis/dis-07' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.reportDetail.choose.text']);
  });
});
