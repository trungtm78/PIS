import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ReviewScreen from './ReviewScreen';
import { FILE_ID, MAKER, READER, REPORT, client, fileRecord, fxCells, mount, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-06', 'FR-DIS-06');
const PATH = `/dis/dis-06?report=${REPORT}`;
const UPLOADED = { file_object_id: FILE_ID, file_sha256: 'b'.repeat(64), file_name: 'scan.pdf', content_type: 'application/pdf', size_bytes: 4096 };
const finding = (code: string, field: string, values: Record<string, string | null> = {}) => ({ code, field, values });

afterEach(cleanup);

const open = (
  record: Record<string, unknown> = reportRecord(),
  options: { command?: (operation: string, input: unknown) => unknown; upload?: () => unknown; permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY' } = {},
) => {
  const h = client(world({ details: { [REPORT]: record } }), options.command ?? (() => ({ status: 'DRAFT', resource_version: 4 })));
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  mount(<ReviewScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : MAKER, path: PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, upload };
};
const pick = (name = 'scan.pdf'): void => {
  const input = screen.getByLabelText(vi_['dis.review.files.pick.label']) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['%PDF-1.4'], name, { type: 'application/pdf' })] } });
};
const bodyOf = (h: { command: { mock: { calls: unknown[][] } } }, call = 0) => (h.command.mock.calls[call]?.[1] as { body: Record<string, unknown>; ifMatchVersion: number }).body;

describe('DIS-06 review and send', () => {
  it('AC-ST-DIS-004-2: tells every error and every warning at once, each with its figures and the step where it is put right, and blocks while there is an error', async () => {
    open(
      reportRecord({
        review: {
          blocking: true,
          errors: [finding('VALIDATION_FAILED', 'progress', { missing: 'construction_vnd' }), finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[0].ctmtqg_subset_vnd', { parent_vnd: '100', subset_vnd: '120' }), finding('PERIOD_LOCKED', 'period')],
          warnings: [
            finding('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd', { construction_vnd: '2038000000', allocated_vnd: '1000000000', ratio_pct: '203.8' }),
            finding('TREASURY_GAP', 'funding_lines', { reported_vnd: '1000', treasury_vnd: '900', gap_pct: '11.1' }),
            finding('NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT', 'funding_lines', { remaining_vnd: '80000000' }),
          ],
        },
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.review.page.title'] })).toBeTruthy();
    expect((await screen.findByTestId('review-status')).textContent).toBe(vi_['dis.review.status.blocking']);
    const errors = within(screen.getByTestId('review-errors')).getAllByRole('listitem');
    expect(errors.map((item) => item.getAttribute('data-code'))).toEqual(['VALIDATION_FAILED', 'SUBSET_EXCEEDS_PARENT', 'PERIOD_LOCKED']);
    expect(errors[0]?.textContent).toContain(vi_['dis.review.finding.volumes.text']);
    expect(errors[1]?.textContent).toContain('CTMTQG 120 đồng lớn hơn 100 đồng của ô Vốn năm NSTW.');
    expect(within(errors[0] as HTMLElement).getByRole('link', { name: vi_['dis.review.fix.link'] }).getAttribute('href')).toBe(`/dis/dis-03?report=${REPORT}`);
    expect(within(errors[1] as HTMLElement).getByRole('link', { name: vi_['dis.review.fix.link'] }).getAttribute('href')).toBe(`/dis/dis-04?report=${REPORT}`);
    // The state of the period is not something a step of the draft can put right: no link.
    expect(within(errors[2] as HTMLElement).queryByRole('link')).toBeNull();
    const warnings = within(screen.getByTestId('review-warnings')).getAllByRole('listitem');
    expect(warnings.map((item) => item.getAttribute('data-code'))).toEqual(['VOLUME_EXCEEDS_ALLOCATION', 'TREASURY_GAP', 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT']);
    expect(warnings[0]?.textContent).toContain('203.8%');
    expect(within(warnings[2] as HTMLElement).getByRole('link', { name: vi_['dis.review.fix.link'] }).getAttribute('href')).toBe(`/dis/dis-05?report=${REPORT}`);
  });

  it('says there is nothing to fix when the review is clean, and that warnings do not stop the sending', async () => {
    open();
    expect((await screen.findByTestId('review-status')).textContent).toBe(vi_['dis.review.status.ready']);
    expect(screen.getByTestId('review-errors-none').textContent).toBe(vi_['dis.review.none.text']);
    expect(screen.getByTestId('review-warnings-none').textContent).toBe(vi_['dis.review.none.text']);
  });

  it('has no review for a report that was handed in, and shows it as read only', async () => {
    open(reportRecord({ status: 'SUBMITTED', review: null }));
    expect((await screen.findByTestId('review-status')).textContent).toBe(vi_['dis.review.status.sent']);
    expect(screen.queryByTestId('review-errors')).toBeNull();
    expect((screen.getByLabelText(vi_['dis.review.notes.results.label']) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['dis.review.notes.save.action'] })).toBeNull();
    expect(screen.queryByLabelText(vi_['dis.review.files.pick.label'])).toBeNull();
  });

  it('shows the change of each cell since the period before, a fall in a warning tone, and says when there is no period before', async () => {
    const cells = fxCells();
    cells[0] = { ...(cells[0] as Record<string, unknown>), previous_cumulative_vnd: '150000000', delta_vnd: '-50000000' };
    cells[1] = { ...(cells[1] as Record<string, unknown>), previous_cumulative_vnd: '100000000', delta_vnd: '100000000' };
    open(reportRecord({ funding_lines: cells }));
    await screen.findByTestId('review-status');
    expect(screen.getByTestId('diff-CURRENT_YEAR:CENTRAL').textContent).toBe('-50.000.000');
    expect(screen.getByTestId('diff-CURRENT_YEAR:CENTRAL').className).toContain('dis-fall');
    expect(screen.getByTestId('diff-CURRENT_YEAR:LOCAL').textContent).toBe('100.000.000');
    expect(screen.getByTestId('diff-CARRYOVER:LOCAL').textContent).toBe(vi_['dis.reportEdit.none.text']);
    cleanup();
    open();
    await screen.findByTestId('review-status');
    expect(screen.getByTestId('diff-none').textContent).toBe(vi_['dis.review.diff.none.text']);
  });

  describe('the notes', () => {
    it('shows the narrative that was kept, and saves the whole of it under the version of the report with the issues it names (AC-ST-DIS-004-1)', async () => {
      const user = userEvent.setup();
      const issue = '00000000-0000-4000-8000-0000000000a1';
      const { h } = open(reportRecord({ narrative: { results: 'Foundations done.', causes: null, solutions: null, proposals: null, linked_issue_ids: [issue] } }));
      await screen.findByTestId('review-status');
      expect((screen.getByLabelText(vi_['dis.review.notes.results.label']) as HTMLTextAreaElement).value).toBe('Foundations done.');
      await user.type(screen.getByLabelText(vi_['dis.review.notes.solutions.label']), '  A second shift.  ');
      await user.click(screen.getByRole('button', { name: vi_['dis.review.notes.save.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_revisions');
      expect((h.command.mock.calls[0]?.[1] as { ifMatchVersion: number }).ifMatchVersion).toBe(3);
      expect(bodyOf(h).narrative).toEqual({ results: 'Foundations done.', solutions: 'A second shift.', linked_issue_ids: [issue] });
      expect(bodyOf(h)).not.toHaveProperty('attachments');
    });

    it('refuses a section above 4000 characters before it sends anything, and tells a refusal of the server in words', async () => {
      const user = userEvent.setup();
      const { h } = open();
      await screen.findByTestId('review-status');
      fireEvent.change(screen.getByLabelText(vi_['dis.review.notes.causes.label']), { target: { value: 'x'.repeat(4001) } });
      await user.click(screen.getByRole('button', { name: vi_['dis.review.notes.save.action'] }));
      expect(await screen.findByText(vi_['dis.review.notes.tooLong.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      cleanup();
      const refused = open(reportRecord(), { command: () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }) });
      await screen.findByTestId('review-status');
      await user.type(screen.getByLabelText(vi_['dis.review.notes.results.label']), 'Done');
      await user.click(screen.getByRole('button', { name: vi_['dis.review.notes.save.action'] }));
      expect((await screen.findByTestId('notes-refusal')).textContent).toBe(vi_['dis.reportProblem.versionConflict']);
      expect(refused.h.command).toHaveBeenCalledTimes(1);
    });

    it('takes the narrative away when every section is emptied', async () => {
      const user = userEvent.setup();
      const { h } = open(reportRecord({ narrative: { results: 'Old', causes: null, solutions: null, proposals: null, linked_issue_ids: [] } }));
      await screen.findByTestId('review-status');
      await user.clear(screen.getByLabelText(vi_['dis.review.notes.results.label']));
      await user.click(screen.getByRole('button', { name: vi_['dis.review.notes.save.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(bodyOf(h).narrative).toEqual({});
    });
  });

  describe('the files (AC-ST-DIS-004-4)', () => {
    it('lists the files attached with their size and that they were scanned clean, and says when there is none', async () => {
      open(reportRecord({ attachments: [fileRecord(1), fileRecord(2, { size_bytes: 100, file_name: 'small.pdf' })] }));
      await screen.findByTestId('review-status');
      const items = within(screen.getByRole('list', { name: vi_['dis.review.files.list.aria'] })).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        `voucher-1.pdf ${vi_['dis.review.files.size.text'].replace('{size}', '2')} ${vi_['dis.review.files.clean.status']} ${vi_['dis.review.files.remove.action'].replace('{name}', 'voucher-1.pdf')}`,
        `small.pdf ${vi_['dis.review.files.size.text'].replace('{size}', '1')} ${vi_['dis.review.files.clean.status']} ${vi_['dis.review.files.remove.action'].replace('{name}', 'small.pdf')}`,
      ]);
      cleanup();
      open();
      await screen.findByTestId('review-status');
      expect(screen.getByTestId('files-none').textContent).toBe(vi_['dis.review.files.none.text']);
    });

    it('uploads a file through the door of the report and attaches it, with the files that were there, as the whole list', async () => {
      const { h, upload } = open(reportRecord({ attachments: [fileRecord(2)] }));
      await screen.findByTestId('review-status');
      pick();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(upload).toHaveBeenCalledTimes(1);
      expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_revisions');
      expect(bodyOf(h).attachments).toEqual([
        { file_object_id: '00000000-0000-4000-8000-004700000002', file_sha256: 'a'.repeat(64), file_name: 'voucher-2.pdf' },
        { file_object_id: FILE_ID, file_sha256: 'b'.repeat(64), file_name: 'scan.pdf' },
      ]);
      expect(bodyOf(h)).not.toHaveProperty('narrative');
    });

    it('shows that a file is being uploaded and scanned, and does not take another meanwhile', async () => {
      let release: (value: unknown) => void = () => undefined;
      const h = client(world({ details: { [REPORT]: reportRecord() } }), () => ({ status: 'DRAFT', resource_version: 4 }));
      (h.client as unknown as { upload: unknown }).upload = vi.fn(() => new Promise((resolve) => (release = resolve)));
      mount(<ReviewScreen route={ROUTE} />, h, { permissions: MAKER, path: PATH });
      await screen.findByTestId('review-status');
      pick('slow.pdf');
      expect((await screen.findByTestId('files-uploading')).textContent).toBe(vi_['dis.review.files.uploading.text'].replace('{name}', 'slow.pdf'));
      expect((screen.getByLabelText(vi_['dis.review.files.pick.label']) as HTMLInputElement).disabled).toBe(true);
      release(UPLOADED);
      await waitFor(() => expect(screen.queryByTestId('files-uploading')).toBeNull());
      expect(h.command).toHaveBeenCalledTimes(1);
    });

    const REFUSALS: Array<[string, number, string]> = [
      ['FILE_NOT_CLEAN', 422, vi_['dis.reportProblem.fileInfected']],
      ['FILE_TYPE_NOT_ALLOWED', 422, vi_['dis.reportProblem.fileType']],
      ['PAYLOAD_TOO_LARGE', 413, vi_['dis.reportProblem.fileTooLarge']],
      ['SCAN_PENDING', 409, vi_['dis.reportProblem.scanPending']],
    ];
    it.each(REFUSALS)('tells the refusal %s of the upload door in words and attaches nothing', async (code, status, message) => {
      const { h } = open(reportRecord(), { upload: () => new ApiError({ status, code, correlationId: 'c' }) });
      await screen.findByTestId('review-status');
      pick();
      expect((await screen.findByTestId('files-refusal')).textContent).toBe(message);
      expect(h.command).not.toHaveBeenCalled();
      expect(screen.getByTestId('files-none')).toBeTruthy();
    });

    it('tells the refusal of the save that attaches the file, and removes a file by saving the list without it', async () => {
      const user = userEvent.setup();
      const { h } = open(reportRecord({ attachments: [fileRecord(1), fileRecord(2)] }), { command: () => new ApiError({ status: 422, code: 'HASH_MISMATCH', correlationId: 'c' }) });
      await screen.findByTestId('review-status');
      await user.click(screen.getByRole('button', { name: vi_['dis.review.files.remove.action'].replace('{name}', 'voucher-1.pdf') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(bodyOf(h).attachments).toEqual([{ file_object_id: '00000000-0000-4000-8000-004700000002', file_sha256: 'a'.repeat(64), file_name: 'voucher-2.pdf' }]);
      expect((await screen.findByTestId('files-refusal')).textContent).toBe(vi_['dis.reportProblem.hashMismatch']);
    });

    it('does not take a file from a person without the right to edit, nor in a tenant that is read only, nor when nothing was picked', async () => {
      open(reportRecord(), { permissions: READER });
      await screen.findByTestId('review-status');
      expect(screen.queryByLabelText(vi_['dis.review.files.pick.label'])).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['dis.review.notes.save.action'] })).toBeNull();
      cleanup();
      open(reportRecord({ attachments: [fileRecord(1)] }), { mode: 'READ_ONLY' });
      await screen.findByTestId('review-status');
      expect(screen.queryByLabelText(vi_['dis.review.files.pick.label'])).toBeNull();
      expect(screen.queryByRole('button', { name: new RegExp(vi_['dis.review.files.remove.action'].split('{name}')[0] ?? 'x') })).toBeNull();
      cleanup();
      const { h, upload } = open();
      await screen.findByTestId('review-status');
      fireEvent.change(screen.getByLabelText(vi_['dis.review.files.pick.label']), { target: { files: [] } });
      expect(upload).not.toHaveBeenCalled();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  it('asks for a report when none is chosen, says nothing is there for one that is not found, and shows the states', async () => {
    mount(<ReviewScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: '/dis/dis-06' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.review.choose.text']);
    cleanup();
    mount(<ReviewScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    const failing = (error: Error) => {
      const state = world({ details: { [REPORT]: reportRecord() } });
      state.failing.set('getReportRevision', error);
      return client(state);
    };
    mount(<ReviewScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<ReviewScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<ReviewScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
