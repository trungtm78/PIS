import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MAKER, READER, REPORT, client, mount, reportRecord, routeOf, world } from '../report/test-support';
import NarrativeScreen from './NarrativeScreen';
import { appendLine, bodyOf, formOf, problemOf, toContext, tooLong } from './model';
import { toReportDetail } from '../report/model';

const ROUTE = routeOf('DIS-34', 'DL.01');
const PATH = '/dis/dis-34';
const DIRECTIVE = '11111111-1111-4111-8111-111111111111';
const CONTEXT = {
  report_id: REPORT,
  causes: [{ code: 'SITE_HANDOVER', label: 'Site handover' }],
  directives: { from: '2027-09-01', to: '2027-09-30', truncated: false, items: [{ id: DIRECTIVE, code: 'CD-7', status_at_end: 'IN_PROGRESS', line: 'CD-7: speed up the handover.', rolled_up: false }] },
  previous: { report_id: '22222222-2222-4222-8222-222222222222', period_code: '2027-M08', status: 'ACCEPTED', fields: ['status', 'schedule'], cause_codes: [] },
  inheritance: null,
  unchanged_inherited: [],
  mandatory: [],
  verdict: { blocking: [], warnings: [] },
};
const report = (narrative: Record<string, unknown> | undefined = undefined, over: Record<string, unknown> = {}) => reportRecord({ report_type: 'MONTHLY', narrative, ...over });

afterEach(cleanup);

const open = (details: Record<string, unknown> = report(), permissions: readonly string[] | undefined = MAKER, context: Record<string, unknown> = CONTEXT, command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_id: REPORT, resource_version: 2 })) => {
  const h = client(world({ details: { [REPORT]: details }, narrativeContext: context }), command);
  mount(<NarrativeScreen route={ROUTE} />, h, { permissions, path: `${PATH}?report=${REPORT}` });
  return h;
};
const bodySent = (h: ReturnType<typeof client>): Record<string, unknown> => (h.command.mock.calls.find((call) => call[0] === 'post_reports_id_revisions')?.[1] as { body: Record<string, unknown> }).body;

describe('DIS-34 structured narrative of a period', () => {
  it('asks for a report when none is named', async () => {
    mount(<NarrativeScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: PATH });
    expect(await screen.findByTestId('no-report')).toBeTruthy();
  });

  it('shows the eight fields, the standard causes and the directives of the period, and saves the whole block with the cause picked', async () => {
    const user = userEvent.setup();
    const h = open();
    for (const field of ['status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals']) {
      expect(await screen.findByLabelText(vi_[`ent3b.narr.field.${field === 'next_plan' ? 'nextPlan' : field}` as keyof typeof vi_])).toBeTruthy();
    }
    await user.type(screen.getByLabelText(vi_['ent3b.narr.field.status']), 'Works continue');
    await user.click(screen.getByLabelText('Site handover'));
    await user.click(screen.getByRole('button', { name: vi_['ent3b.narr.save.action'] }));
    await waitFor(() => expect(h.command.mock.calls.some((call) => call[0] === 'post_reports_id_revisions')).toBe(true));
    expect(bodySent(h).narrative).toEqual({ enterprise: { status: 'Works continue', cause_codes: ['SITE_HANDOVER'] } });
    expect(await screen.findByTestId('saved')).toBeTruthy();
  });

  it('adds the line of a directive to the status field once, and keeps a reference to it in the block', async () => {
    const user = userEvent.setup();
    const h = open();
    await user.click(await screen.findByRole('button', { name: vi_['ent3b.narr.directives.add'] }));
    expect((screen.getByLabelText(vi_['ent3b.narr.field.status']) as HTMLTextAreaElement).value).toBe('CD-7: speed up the handover.');
    expect(screen.queryByRole('button', { name: vi_['ent3b.narr.directives.add'] })).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['ent3b.narr.save.action'] }));
    await waitFor(() => expect(h.command.mock.calls.some((call) => call[0] === 'post_reports_id_revisions')).toBe(true));
    expect(bodySent(h).narrative).toEqual({ enterprise: { status: 'CD-7: speed up the handover.', directive_refs: [{ id: DIRECTIVE, code: 'CD-7', status_at_end: 'IN_PROGRESS' }] } });
  });

  it('inherits the previous period under the version shown, and says so when there is nothing to inherit', async () => {
    const user = userEvent.setup();
    const h = open();
    await user.click(await screen.findByRole('button', { name: vi_['ent3b.narr.inherit.action'] }));
    await waitFor(() => expect(h.command.mock.calls.some((call) => call[0] === 'inheritReportNarrative')).toBe(true));
    cleanup();
    open(report(), MAKER, { ...CONTEXT, previous: null });
    expect(await screen.findByTestId('no-previous')).toBeTruthy();
  });

  it('shows what the approved rules say, and the reason when the server refuses', async () => {
    const user = userEvent.setup();
    open(report(), MAKER, { ...CONTEXT, verdict: { blocking: [{ rule_code: 'NARRATIVE_MANDATORY_FIELDS', check: 'FIELD_REQUIRED', fields: ['NARRATIVE_STATUS'], message: 'Status is required.' }], warnings: [] } }, () => new ApiError({ status: 422, code: 'IND_ENTRY_RULE_VIOLATED', correlationId: 'c' }));
    expect(await screen.findByText('Status is required.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['ent3b.narr.save.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['ent3b.narr.problem.invalid']);
  });

  it('is read only for a person who may not edit, and for a report that was handed in', async () => {
    open(report(), READER);
    expect(await screen.findByTestId('read-only')).toBeTruthy();
    expect((screen.getByLabelText(vi_['ent3b.narr.field.status']) as HTMLTextAreaElement).readOnly).toBe(true);
    cleanup();
    open(report(undefined, { status: 'SUBMITTED' }));
    expect(await screen.findByTestId('read-only')).toBeTruthy();
  });
});

describe('the model of the structured narrative', () => {
  const detail = toReportDetail(report({ results: 'Public words', linked_issue_ids: ['a'], enterprise: { status: 'Works', schedule: null, cause_codes: ['X'], directive_refs: [] } }));

  it('reads the block into a form and writes it back whole beside the public sections and the issues', () => {
    expect(detail).toBeDefined();
    const form = formOf(detail as NonNullable<typeof detail>);
    expect(form.fields.status).toBe('Works');
    expect(form.fields.schedule).toBe('');
    expect(bodyOf(detail as NonNullable<typeof detail>, form).narrative).toEqual({ results: 'Public words', linked_issue_ids: ['a'], enterprise: { status: 'Works', cause_codes: ['X'] } });
  });

  it('judges the length of a field, appends a line once and maps the refusals of the server', () => {
    const form = formOf(detail as NonNullable<typeof detail>);
    expect(tooLong({ ...form, fields: { ...form.fields, causes: 'x'.repeat(4001) } })).toEqual(['causes']);
    expect(appendLine('', 'A')).toBe('A');
    expect(appendLine('A', 'B')).toBe('A\nB');
    expect(appendLine('A\nB', 'B')).toBe('A\nB');
    expect(problemOf(new ApiError({ status: 409, code: 'NARRATIVE_NOTHING_TO_INHERIT', correlationId: 'c' }))).toBe('nothing');
    expect(problemOf(new Error('x'))).toBe('general');
    expect(toContext(undefined).causes).toEqual([]);
  });
});
