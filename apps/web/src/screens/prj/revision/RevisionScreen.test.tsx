import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import LegalDossierScreen from './LegalDossierScreen';
import RevisionScreen from './RevisionScreen';
import { EMPTY_DECISION, EMPTY_PROPOSAL, canDecide, changesOf, decisionBody, describeRevision, dossierOf, holds, pendingOf, proposalBody, toRevisionRegister, validateDecision, validateProposal, vietnamToday } from './model';
import type { DecisionForm, ProposalForm } from './model';

const ROUTE = routeOf('PRJ-06', 'FR-PRJ-06');
const DOSSIER_ROUTE = routeOf('PRJ-04', 'FR-PRJ-04');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const UNIT = '00000000-0000-4000-8000-0000000000a1';
const PROPOSER = ['project.read', 'project.revision.propose'];
const DECIDER = ['project.read', 'project.revision.approve'];
const READER = ['project.read'];
const OK = { operation_id: 'o', status: 'IN_REVIEW', resource_version: 1, resource_id: 'x' };
const PROJECT = line(1).id;

const person = (id: string, name: string) => ({ membership_id: id, display_name: name });
const revision = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  revision: n,
  change_kind: 'ADJUST_INVESTMENT',
  status: 'APPROVED',
  before: { total_investment_vnd: '45000000000' },
  after: { total_investment_vnd: '55000000000' },
  total_investment_vnd: '55000000000',
  reason: 'The cost of the site clearance went up',
  decision_reason: 'Approved by the people committee',
  decision_document: { id: DOCUMENT, title: 'Decision on the adjustment', number: 12, number_year: 2026, symbol: 'QD-12/2026', issued_on: '2026-01-15', effect_status: 'EFFECTIVE' },
  effective_from: '2026-02-01',
  supersedes_id: null,
  created_by: person(OTHER, 'Trần Thị Bình'),
  created_at: '2026-01-10T01:00:00.000000Z',
  decided_by: person(ME, 'Nguyễn Văn An'),
  decided_at: '2026-01-15T01:00:00.000000Z',
  version: 2,
  ...overrides,
});
const initial = revision(1, { change_kind: 'INITIAL', status: 'DRAFT', before: {}, after: { total_investment_vnd: '45000000000' }, total_investment_vnd: '45000000000', decision_document: null, decision_reason: null, effective_from: null, decided_by: null, decided_at: null, version: 1, reason: 'INITIAL_REGISTRATION' });
const answer = (items: unknown[], total = '55000000000') => ({ items, current_total_investment_vnd: total, as_of: '2026-10-31' });

afterEach(cleanup);

function Jump({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      jump
    </button>
  );
}

function open(served: { pages: Array<Record<string, unknown>>; failing?: Error }, command: (operation: string, input: unknown) => unknown = () => OK, projects: Array<Record<string, unknown>> = [line(1, { status: 'IMPLEMENTATION', version: 3 })]): Harness {
  const h = client(world({ projects }), command);
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listProjectRevisions') {
      if (served.failing !== undefined) return Promise.reject(served.failing);
      const page = served.pages[Math.min(call, served.pages.length - 1)];
      call += 1;
      return Promise.resolve(page);
    }
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

const show = (h: Harness, permissions: readonly string[], options: { mode?: 'FULL' | 'READ_ONLY'; project?: boolean; screen?: 'revision' | 'dossier' } = {}) =>
  mount(options.screen === 'dossier' ? <LegalDossierScreen route={DOSSIER_ROUTE} /> : <RevisionScreen route={ROUTE} />, h, {
    permissions,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    path: `/prj/${options.screen === 'dossier' ? 'prj-04' : 'prj-06'}${options.project === false ? '' : `?id=${PROJECT}`}`,
  });
const asked = (h: Harness) => h.read.mock.calls.filter(([name]) => name === 'listProjectRevisions').map(([, input]) => input as { path?: Record<string, string> });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('RevisionScreen (PRJ-06): the adjustment of a project', () => {
  it('UI-PRJ-06: puts the old content next to the new, the basis and the day it takes effect, and the state in words; a reader only reads', async () => {
    const h = open({
      pages: [
        answer([
          revision(4, { status: 'IN_REVIEW', change_kind: 'ADJUST_SCHEDULE', before: { end_year: 2028 }, after: { end_year: 2030 }, decision_document: null, decision_reason: null, effective_from: null, decided_by: null, decided_at: null, version: 1, reason: 'The works need two more years' }),
          revision(3),
          revision(2, { status: 'SUPERSEDED', before: { total_investment_vnd: '40000000000' }, after: { total_investment_vnd: '45000000000' } }),
          initial,
        ]),
      ],
    });
    show(h, READER);
    const table = await screen.findByTestId('revisions');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.revision.page.title']);
    for (const key of ['prj.revision.col.revision', 'prj.revision.col.before', 'prj.revision.col.after', 'prj.revision.col.basis', 'prj.revision.col.effective', 'prj.revision.col.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain(vi_['prj.revision.kind.schedule']);
    expect(rows[0]?.querySelector('[data-side="before"]')?.textContent).toContain(`${vi_['prj.revision.field.endYear.name']}: 2028`);
    expect(rows[0]?.querySelector('[data-side="after"]')?.textContent).toContain(`${vi_['prj.revision.field.endYear.name']}: 2030`);
    expect(rows[0]?.textContent).toContain('The works need two more years');
    expect(rows[0]?.textContent).toContain(vi_['prj.revision.status.inReview']);
    expect(rows[1]?.querySelector('[data-side="before"]')?.textContent).toContain('45.000.000.000');
    expect(rows[1]?.querySelector('[data-side="after"]')?.textContent).toContain('55.000.000.000');
    expect(rows[1]?.textContent).toContain(vi_['prj.revision.document.issued'].replace('{name}', 'QD-12/2026').replace('{date}', '2026-01-15'));
    expect(rows[1]?.textContent).toContain('2026-02-01');
    expect(rows[1]?.textContent).toContain(vi_['prj.revision.decision.note'].replace('{note}', 'Approved by the people committee'));
    expect(rows[1]?.textContent).toContain(vi_['prj.revision.status.approved']);
    expect(rows[2]?.textContent).toContain(vi_['prj.revision.status.superseded']);
    expect(rows[3]?.textContent).toContain(vi_['prj.revision.kind.initial']);
    expect(rows[3]?.textContent).toContain(vi_['prj.revision.status.draft']);
    expect(screen.getByTestId('current-total').textContent).toContain('55.000.000.000');
    expect(screen.getByTestId('pending-notice').textContent).toBe(vi_['prj.revision.pending.notice'].replace('{revision}', '4'));
    expect(asked(h)[0]).toEqual({ path: { id: PROJECT } });
    expect(screen.queryByRole('form', { name: vi_['prj.revision.form.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.revision.decide.action'] })).toBeNull();
  });

  it('asks to choose a project when the address names none, and starts over when the address moves to another project', async () => {
    const h = open({ pages: [answer([initial])] }, () => OK, [line(1, { status: 'IMPLEMENTATION', version: 3 }), line(2, { status: 'IMPLEMENTATION', version: 1 })]);
    mount(
      <>
        <RevisionScreen route={ROUTE} />
        <Jump to={`/prj/prj-06?id=${line(2).id}`} />
      </>,
      h,
      { permissions: DECIDER, path: '/prj/prj-06' },
    );
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.revision.noProject.notice']);
    expect(asked(h)).toHaveLength(0);
    const chooser = (await screen.findByLabelText(vi_['prj.revision.filter.project.label'])) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(chooser.options).some((option) => option.value === PROJECT)).toBe(true));
    fireEvent.change(chooser, { target: { value: PROJECT } });
    expect(await screen.findByTestId('revisions')).toBeTruthy();
    expect(asked(h)[0]?.path).toEqual({ id: PROJECT });
    fireEvent.click(screen.getByRole('button', { name: 'jump' }));
    await waitFor(() => expect(asked(h).at(-1)?.path).toEqual({ id: line(2).id }));
  });

  it('says in words that the history could not be read and reads it again on request', async () => {
    const h = open({ pages: [answer([])], failing: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) });
    show(h, READER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(asked(h).length).toBeGreaterThanOrEqual(2));
  });

  describe('proposing (AC-ST-PRJ-008-2)', () => {
    it('refuses before it sends what is missing, the total in force, a year out of range and an identifier that is not one', async () => {
      const h = open({ pages: [answer([initial], '45000000000')] });
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['prj.revision.form.title'] });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
      expect((await within(form).findAllByText(vi_['prj.revision.field.required.error'])).length).toBe(2);
      type(vi_['prj.revision.field.total.label'], '45000000000');
      type(vi_['prj.revision.field.reason.label'], 'short');
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
      expect(await within(form).findByText(vi_['prj.revision.field.same.error'])).toBeTruthy();
      expect(within(form).getByText(vi_['prj.revision.field.invalid.error'])).toBeTruthy();
      fireEvent.change(within(form).getByLabelText(vi_['prj.revision.field.kind.label']), { target: { value: 'ADJUST_SCHEDULE' } });
      type(vi_['prj.revision.field.startYear.label'], '1800');
      type(vi_['prj.revision.field.reason.label'], 'The works need two more years');
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
      expect(await within(form).findByText(vi_['prj.revision.field.invalid.error'])).toBeTruthy();
      fireEvent.change(within(form).getByLabelText(vi_['prj.revision.field.kind.label']), { target: { value: 'ADJUST_INVESTOR' } });
      type(vi_['prj.revision.field.investor.label'], 'not an identifier');
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
      expect(await within(form).findByText(vi_['prj.revision.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the proposal under the version of the project the screen showed, and starts the form over once it is sent', async () => {
      const h = open({ pages: [answer([initial], '45000000000')] });
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['prj.revision.form.title'] });
      type(vi_['prj.revision.field.total.label'], '55000000000');
      type(vi_['prj.revision.field.reason.label'], '  The cost of the site clearance went up ');
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('proposeProjectRevision');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: PROJECT }, ifMatchVersion: 3, body: { change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '55000000000', reason: 'The cost of the site clearance went up' } });
      expect((await screen.findByTestId('propose-saved')).textContent).toBe(vi_['prj.revision.form.saved']);
      expect((within(form).getByLabelText(vi_['prj.revision.field.total.label']) as HTMLInputElement).value).toBe('');
    });

    it('sends a schedule, a scope and an investor proposal with the fields of its kind only', async () => {
      const h = open({ pages: [answer([initial], '45000000000')] });
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['prj.revision.form.title'] });
      const send = async (kind: string, fill: () => void) => {
        fireEvent.change(within(form).getByLabelText(vi_['prj.revision.field.kind.label']), { target: { value: kind } });
        fill();
        type(vi_['prj.revision.field.reason.label'], 'The works need two more years');
        fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
        await waitFor(() => expect(h.command.mock.calls.length).toBeGreaterThanOrEqual(1));
      };
      await send('ADJUST_SCHEDULE', () => type(vi_['prj.revision.field.endYear.label'], '2030'));
      expect(h.command.mock.calls.at(-1)?.[1]).toMatchObject({ body: { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2030 } } });
      expect((h.command.mock.calls.at(-1)?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('total_investment_vnd');
      await send('ADJUST_SCOPE', () => type(vi_['prj.revision.field.scope.label'], 'Add a pedestrian bridge on the north bank'));
      await waitFor(() => expect(h.command.mock.calls).toHaveLength(2));
      expect(h.command.mock.calls.at(-1)?.[1]).toMatchObject({ body: { change_kind: 'ADJUST_SCOPE', after: { scope_summary: 'Add a pedestrian bridge on the north bank' } } });
      await send('ADJUST_INVESTOR', () => type(vi_['prj.revision.field.investor.label'], UNIT));
      await waitFor(() => expect(h.command.mock.calls).toHaveLength(3));
      expect(h.command.mock.calls.at(-1)?.[1]).toMatchObject({ body: { change_kind: 'ADJUST_INVESTOR', after: { investor_unit_id: UNIT } } });
    });

    it('says in words why the server refused the proposal', async () => {
      const h = open({ pages: [answer([initial], '45000000000')] }, () => new ApiError({ status: 409, code: 'REVISION_PENDING_EXISTS', correlationId: 'c' }));
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['prj.revision.form.title'] });
      type(vi_['prj.revision.field.total.label'], '55000000000');
      type(vi_['prj.revision.field.reason.label'], 'The cost of the site clearance went up');
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.revision.form.submit.action'] }));
      expect((await within(form).findByTestId('propose-refusal')).textContent).toBe(vi_['prj.revision.problem.pendingExists']);
    });

    it('offers no form while a proposal waits or in a stage that takes none, and none to a session that is read only', async () => {
      const waiting = open({ pages: [answer([revision(2, { status: 'IN_REVIEW', decision_document: null, effective_from: null, decided_by: null, decision_reason: null, version: 1 }), initial])] });
      show(waiting, PROPOSER);
      await screen.findByTestId('revisions');
      expect(screen.queryByRole('form', { name: vi_['prj.revision.form.title'] })).toBeNull();
      cleanup();
      const concept = open({ pages: [answer([initial], '45000000000')] }, () => OK, [line(1, { status: 'CONCEPT' })]);
      show(concept, PROPOSER);
      expect((await screen.findByTestId('stage-notice')).textContent).toBe(vi_['prj.revision.stage.notice']);
      expect(screen.queryByRole('form', { name: vi_['prj.revision.form.title'] })).toBeNull();
      cleanup();
      show(open({ pages: [answer([initial], '45000000000')] }), PROPOSER, { mode: 'READ_ONLY' });
      await screen.findByTestId('revisions');
      expect(screen.queryByRole('form', { name: vi_['prj.revision.form.title'] })).toBeNull();
    });
  });

  describe('deciding (AC-ST-PRJ-008-1)', () => {
    const waiting = (overrides: Record<string, unknown> = {}) => revision(2, { status: 'IN_REVIEW', decision_document: null, decision_reason: null, effective_from: null, decided_by: null, decided_at: null, version: 5, ...overrides });

    it('offers the decision to a decider on a proposal that is not their own only', async () => {
      const h = open({ pages: [answer([waiting({ created_by: person(ME, 'Nguyễn Văn An') }), waiting({ id: '00000000-0000-4000-8000-0000000000e9', revision: 3 }), initial])] });
      show(h, DECIDER);
      await screen.findByTestId('revisions');
      expect(screen.getAllByRole('button', { name: vi_['prj.revision.decide.action'] })).toHaveLength(1);
    });

    it('UAT-AC214: refuses before it sends an approval without a document or a day, a day after today and an identifier that is not one; then sends the decision under the version of the revision', async () => {
      const h = open({ pages: [answer([waiting(), initial])] });
      show(h, DECIDER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.revision.decide.action'] }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.revision.decide.submit.action'] }));
      expect((await within(dialog).findAllByText(vi_['prj.revision.field.required.error'])).length).toBe(3);
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.revision.decide.reason.label']), { target: { value: 'Approved by the people committee' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.revision.decide.document.label']), { target: { value: 'not an identifier' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.revision.decide.effective.label']), { target: { value: '2999-01-01' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.revision.decide.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.revision.field.invalid.error'])).toBeTruthy();
      expect(within(dialog).getByText(vi_['prj.revision.field.future.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.revision.decide.document.label']), { target: { value: DOCUMENT } });
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.revision.decide.effective.label']), { target: { value: '2026-02-01' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.revision.decide.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('decideProjectRevision');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: waiting().id }, ifMatchVersion: 5, body: { decision: 'approve', reason: 'Approved by the people committee', decision_document_id: DOCUMENT, effective_from: '2026-02-01' } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('rejects with a reason and no day, and says in words why the server refused', async () => {
      const h = open({ pages: [answer([waiting(), initial])] }, () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
      show(h, DECIDER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.revision.decide.action'] }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByLabelText(vi_['prj.revision.decide.reject']));
      expect(within(dialog).queryByLabelText(vi_['prj.revision.decide.effective.label'])).toBeNull();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.revision.decide.reason.label']), { target: { value: 'The estimate is not supported' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.revision.decide.submit.action'] }));
      expect((await within(dialog).findByTestId('decide-refusal')).textContent).toBe(vi_['prj.revision.problem.selfApproval']);
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'reject', reason: 'The estimate is not supported' } });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('effective_from');
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.revision.dialog.close.label'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.revision.decide.action'] }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['prj.revision.dialog.cancel.action'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });
});

describe('LegalDossierScreen (PRJ-04): the legal dossier of a project', () => {
  it('UI-PRJ-04: lists the decision number, the day it takes effect and the version of each approved adjustment, and leaves out what has no document', async () => {
    const h = open({ pages: [answer([revision(3, { status: 'IN_REVIEW', decision_document: null }), revision(2), initial])] });
    show(h, READER, { screen: 'dossier' });
    const table = await screen.findByTestId('dossier');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.dossier.page.title']);
    for (const key of ['prj.dossier.col.number', 'prj.dossier.col.effective', 'prj.dossier.col.revision'] as const) expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('QD-12/2026 ngày 2026-01-15');
    expect(rows[0]?.textContent).toContain('Decision on the adjustment');
    expect(rows[0]?.textContent).toContain('2026-02-01');
    expect(rows[0]?.textContent).toContain(vi_['prj.revision.row.number'].replace('{revision}', '2'));
    expect(screen.getByRole('link', { name: vi_['prj.dossier.revisions.link'] }).getAttribute('href')).toBe(`/prj/prj-06?id=${PROJECT}`);
  });

  it('says that nothing grounds the project yet, asks for a project when none is named, and says when it could not be read', async () => {
    show(open({ pages: [answer([initial])] }), READER, { screen: 'dossier' });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    show(open({ pages: [answer([])] }), READER, { screen: 'dossier', project: false });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.revision.noProject.notice']);
    cleanup();
    show(open({ pages: [answer([])], failing: new Error('failed') }), READER, { screen: 'dossier' });
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });
});

describe('the model of the revisions', () => {
  it('reads a history, leaves out what is not a revision, and finds the pending and the dossier ones', () => {
    const read = toRevisionRegister(answer([revision(3, { status: 'IN_REVIEW', decision_document: null }), revision(2), initial, { id: 'x' }, revision(5, { status: 'LOST' }), revision(6, { created_by: {} }), revision(7, { change_kind: 'OTHER' }), null]));
    expect(read.items.map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(read.currentTotalVnd).toBe('55000000000');
    expect(toRevisionRegister(undefined)).toEqual({ items: [], currentTotalVnd: '0' });
    expect(pendingOf(read.items)?.revision).toBe(3);
    expect(dossierOf(read.items).map((item) => item.revision)).toEqual([2]);
    expect(read.items[1]?.document).toMatchObject({ id: DOCUMENT, number: 12, numberYear: 2026, symbol: 'QD-12/2026', issuedOn: '2026-01-15' });
    expect(read.items[1]?.decidedBy).toEqual({ membershipId: ME, displayName: 'Nguyễn Văn An' });
    const bare = toRevisionRegister(answer([revision(2, { decision_document: { id: DOCUMENT, number: 'x', symbol: 5 }, before: 'x', after: null, decided_by: null, total_investment_vnd: 5 })]));
    expect(bare.items[0]).toMatchObject({ document: { title: '', number: null, symbol: null }, before: {}, after: {}, decidedBy: null, totalInvestmentVnd: null });
    expect(toRevisionRegister(answer([revision(2, { decision_document: { title: 'no id' } })])).items[0]?.document).toBeNull();
  });

  it('knows who may decide, what a permission and a session allow, and the fields a revision moves in a fixed order', () => {
    expect([canDecide({ status: 'IN_REVIEW', createdBy: { membershipId: OTHER, displayName: null } }, ME), canDecide({ status: 'IN_REVIEW', createdBy: { membershipId: ME, displayName: null } }, ME), canDecide({ status: 'APPROVED', createdBy: { membershipId: OTHER, displayName: null } }, ME), canDecide({ status: 'IN_REVIEW', createdBy: { membershipId: ME, displayName: null } }, undefined)]).toEqual([true, false, false, true]);
    expect([holds(DECIDER, 'project.revision.approve', undefined), holds(READER, 'project.revision.approve', undefined), holds(undefined, 'x', 'FULL'), holds(DECIDER, 'project.revision.approve', 'READ_ONLY')]).toEqual([true, false, true, false]);
    expect(changesOf({ before: { end_year: 2028, a_field: 1 }, after: { end_year: 2030, total_investment_vnd: '1', start_year: 2027 } })).toEqual([
      { field: 'total_investment_vnd', before: null, after: '1' },
      { field: 'start_year', before: null, after: 2027 },
      { field: 'end_year', before: 2028, after: 2030 },
      { field: 'a_field', before: 1, after: null },
    ]);
  });

  const FORM: ProposalForm = { ...EMPTY_PROPOSAL, total: '55000000000', reason: 'The cost of the site clearance went up' };

  it('checks a proposal by its kind and builds the body the server takes', () => {
    const current = { totalVnd: '45000000000' };
    expect(validateProposal(FORM, current)).toEqual({});
    expect(validateProposal({ ...FORM, total: '45000000000' }, current)).toEqual({ total: 'same' });
    expect(validateProposal({ ...FORM, total: '1.5', reason: ' ' }, current)).toEqual({ total: 'invalid', reason: 'required' });
    expect(validateProposal({ ...FORM, total: '1'.repeat(25) }, current)).toEqual({ total: 'invalid' });
    const schedule: ProposalForm = { ...FORM, kind: 'ADJUST_SCHEDULE' };
    expect(validateProposal(schedule, current)).toEqual({ startYear: 'required' });
    expect(validateProposal({ ...schedule, startYear: '2030', endYear: '2028' }, current)).toEqual({ endYear: 'invalid' });
    expect(validateProposal({ ...schedule, startYear: '20x0', endYear: '2101' }, current)).toEqual({ startYear: 'invalid', endYear: 'invalid' });
    expect(validateProposal({ ...schedule, endYear: '2030' }, current)).toEqual({});
    expect(validateProposal({ ...FORM, kind: 'ADJUST_SCOPE', scope: ' ' }, current)).toEqual({ scope: 'required' });
    expect(validateProposal({ ...FORM, kind: 'ADJUST_SCOPE', scope: 'short' }, current)).toEqual({ scope: 'invalid' });
    expect(validateProposal({ ...FORM, kind: 'ADJUST_INVESTOR', investorUnit: UNIT }, current)).toEqual({});
    expect(validateProposal({ ...FORM, kind: 'ADJUST_INVESTOR' }, current)).toEqual({ investorUnit: 'required' });
    expect(proposalBody({ ...FORM, total: ' 55000000000 ', reason: ' The cost of the site clearance went up ' })).toEqual({ change_kind: 'ADJUST_INVESTMENT', after: {}, total_investment_vnd: '55000000000', reason: 'The cost of the site clearance went up' });
    expect(proposalBody({ ...schedule, startYear: '2027', reason: 'The works need two more years' })).toEqual({ change_kind: 'ADJUST_SCHEDULE', after: { start_year: 2027 }, reason: 'The works need two more years' });
    expect(proposalBody({ ...FORM, kind: 'ADJUST_SCOPE', scope: ' Add a pedestrian bridge ' }).after).toEqual({ scope_summary: 'Add a pedestrian bridge' });
    expect(proposalBody({ ...FORM, kind: 'ADJUST_INVESTOR', investorUnit: ` ${UNIT} ` }).after).toEqual({ investor_unit_id: UNIT });
  });

  const DECISION: DecisionForm = { ...EMPTY_DECISION, reason: 'Approved by the committee', documentId: DOCUMENT, effectiveFrom: '2026-02-01' };

  it('checks a decision, builds its body, tells the day in Vietnam and what the server refused', () => {
    const today = '2026-10-31';
    expect(validateDecision(DECISION, today)).toEqual({});
    expect(validateDecision(EMPTY_DECISION, today)).toEqual({ reason: 'required', documentId: 'required', effectiveFrom: 'required' });
    expect(validateDecision({ ...DECISION, reason: 'No', documentId: 'x', effectiveFrom: '2026-02-30' }, today)).toEqual({ reason: 'invalid', documentId: 'invalid', effectiveFrom: 'invalid' });
    expect(validateDecision({ ...DECISION, effectiveFrom: '2026-11-01' }, today)).toEqual({ effectiveFrom: 'past' });
    expect(validateDecision({ decision: 'reject', reason: 'Not justified', documentId: '', effectiveFrom: '' }, today)).toEqual({});
    expect(validateDecision({ decision: 'reject', reason: 'Not justified', documentId: 'x', effectiveFrom: '' }, today)).toEqual({ documentId: 'invalid' });
    expect(decisionBody(DECISION)).toEqual({ decision: 'approve', reason: 'Approved by the committee', decision_document_id: DOCUMENT, effective_from: '2026-02-01' });
    expect(decisionBody({ decision: 'reject', reason: ' Not justified ', documentId: ' ', effectiveFrom: '2026-02-01' })).toEqual({ decision: 'reject', reason: 'Not justified' });
    expect(vietnamToday(new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-31');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const refusal = (status: number, code: string) => describeRevision(new ApiError({ status, code, correlationId: 'c' }));
    expect([refusal(409, 'REVISION_PENDING_EXISTS'), refusal(403, 'SELF_APPROVAL_DENIED'), refusal(409, 'VERSION_CONFLICT'), refusal(409, 'STAGE_TRANSITION_DENIED'), refusal(403, 'SCOPE_DENIED'), refusal(422, 'DECISION_REQUIRED'), refusal(422, 'VALIDATION_FAILED'), refusal(400, 'INVALID_REQUEST'), refusal(404, 'RESOURCE_NOT_FOUND'), refusal(500, 'X'), describeRevision(new Error('x'))]).toEqual([
      'pendingExists', 'selfApproval', 'versionConflict', 'stageDenied', 'scopeDenied', 'documentRequired', 'validation', 'validation', 'notFound', 'general', 'general',
    ]);
  });
});
