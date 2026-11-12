import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../../i18n';
import { harness } from '../../../../screens/sas/test-support';
import { mount, uuid } from '../shared/test-support';
import ProfileScreen from './ProfileScreen';
import { BUILT_IN_DOC_TYPES, camel, evidenceOf, findingsOf, isNamedOrigin, milestoneTone, reachedWithoutEvidence, toProfile, yearProblem } from './model';
import type { Profile } from './model';

const route = { id: 'IPF-01', path: '/ipf/ipf-01', title: 'IPF-01', kind: 'detail', area: 'investment', module: 'IPF', group: 'Investment profile', role: 'workspace', parent: null, req: 'FR-IPF-01' } as never;
const PROJECT = uuid(1);
const OTHER = uuid(2);
const READER = ['project.read'];

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const milestone = (over: Partial<Profile['milestones'][number]> = {}): Profile['milestones'][number] => ({
  code: 'INVESTMENT_POLICY',
  label: 'Quyết định chủ trương đầu tư',
  sequence: 10,
  phase: 'PREPARATION',
  required: true,
  evidence_kinds: ['INVESTMENT_POLICY_DECISION'],
  state: 'REACHED',
  planned_on: '2025-01-10',
  actual_on: '2025-01-12',
  ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  project_id: PROJECT,
  plan_year: 2026,
  as_of: '2026-11-12',
  project_type: { code: 'CAPEX_CONSTRUCTION', label: 'Đầu tư xây dựng cơ bản', kind: 'CAPITAL_WORKS' },
  start_flag: 'CONTINUING',
  start_year: 2025,
  start_year_basis: 'ACTUAL',
  plans: [{ plan_code: 'KH-2026', status: 'PUBLISHED', revision: 2 }],
  milestones: [
    milestone(),
    milestone({ code: 'FS_APPROVAL', label: 'Phê duyệt báo cáo nghiên cứu khả thi', sequence: 30, phase: 'APPROVAL', evidence_kinds: ['FS_APPROVAL_DECISION'], state: 'REACHED', planned_on: '2025-03-01', actual_on: '2025-01-05' }),
    milestone({ code: 'TMDT_APPROVAL', label: 'Phê duyệt tổng mức đầu tư', sequence: 40, phase: 'APPROVAL', evidence_kinds: ['TMDT_APPROVAL_DECISION'], state: 'NOT_HELD', planned_on: null, actual_on: null }),
    milestone({ code: 'GROUNDBREAKING', label: 'Khởi công', sequence: 60, phase: 'EXECUTION', evidence_kinds: ['GROUNDBREAKING_RECORD'], state: 'DELAYED', planned_on: '2025-06-01', actual_on: null }),
    milestone({ code: 'ACCEPTANCE', label: 'Nghiệm thu', sequence: 70, phase: 'CLOSURE', required: false, evidence_kinds: ['ACCEPTANCE_RECORD'], state: 'PLANNED', planned_on: '2027-01-01', actual_on: null }),
    milestone({ code: 'FINAL_SETTLEMENT', label: 'Quyết toán', sequence: 80, phase: 'CLOSURE', evidence_kinds: ['SETTLEMENT_DECISION'], state: 'CANCELLED', planned_on: '2027-06-01', actual_on: null }),
  ],
  findings: ['MILESTONE_ORDER:FS_APPROVAL', 'REQUIRED_SKIPPED:TMDT_APPROVAL', 'ODD:X'],
  origin_split: {
    total_vnd: '3000000000',
    group_assigned_vnd: '2000000000',
    board_approved_vnd: '1000000000',
    other_vnd: '0',
    origins: [
      { origin: 'BOARD_APPROVED', amount_vnd: '1000000000', lines: 1, decisions: [{ kind: 'COMPANY_DECISION', symbol: '12/QD-PVFCCo', issued_on: '2026-02-01', authority: 'Hội đồng quản trị' }] },
      { origin: 'GROUP_ASSIGNED', amount_vnd: '2000000000', lines: 2, decisions: [{ kind: 'GROUP_RESOLUTION', symbol: '88/NQ-PVN', issued_on: null, authority: null }, { kind: null, symbol: 'KHAC-1', issued_on: null, authority: null }] },
    ],
  },
  legal_documents: [
    {
      legal_doc_type: 'INVESTMENT_POLICY_DECISION',
      label: 'Quyết định chủ trương đầu tư',
      issuer: 'GROUP',
      purpose: 'LIFECYCLE_EVIDENCE',
      count: 21,
      documents: [{ id: uuid(40), title: 'Quyết định chủ trương', reference: '55/QD-PVN', effective_from: '2025-01-01', effective_to: null, effective_state: 'IN_FORCE', status: 'ACTIVE' }],
    },
    {
      legal_doc_type: 'TENANT_OWN_TYPE',
      label: 'TENANT_OWN_TYPE',
      issuer: null,
      purpose: null,
      count: 1,
      documents: [{ id: uuid(41), title: 'Văn bản riêng', reference: null, effective_from: null, effective_to: null, effective_state: 'UNDATED', status: 'ACTIVE' }],
    },
  ],
  ...over,
});

interface Options {
  reply?: (input: unknown) => unknown;
  projects?: unknown[] | Error;
  path?: string;
}

function mountWith(options: Options = {}) {
  const reads: Array<{ operation: string; input: unknown }> = [];
  const h = harness((operation, input) => {
    reads.push({ operation, input });
    if (operation !== 'getProjectInvestmentProfile') return new Error(`unexpected read ${operation}`);
    return (options.reply ?? (() => profile()))(input);
  });
  const projects = options.projects ?? [
    { id: PROJECT, code: 'DA-01', name: 'Nhà máy' },
    { id: OTHER, code: 'DA-02' },
    { id: 7, code: 'BAD' },
  ];
  (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => (projects instanceof Error ? Promise.reject(projects) : Promise.resolve(projects));
  mount(<ProfileScreen route={route} />, h, { permissions: READER, path: options.path ?? `/ipf/ipf-01?project=${PROJECT}` });
  return { h, reads };
}

describe('the investment profile model', () => {
  it('reads the profile only when its lists and its split are there', () => {
    expect(toProfile(profile()).plan_year).toBe(2026);
    expect(() => toProfile({ plans: [] })).toThrow('unexpected investment profile');
    expect(() => toProfile(null)).toThrow('unexpected investment profile');
  });

  it('judges the year of the form', () => {
    expect(yearProblem('')).toBeUndefined();
    expect(yearProblem(' 2027 ')).toBeUndefined();
    expect(yearProblem('27')).toBe('format');
    expect(yearProblem('20x6')).toBe('format');
    expect(yearProblem('1999')).toBe('range');
    expect(yearProblem('2101')).toBe('range');
  });

  it('drops a finding it does not know instead of guessing', () => {
    expect(findingsOf(['MILESTONE_ORDER:A', 'REQUIRED_SKIPPED:B', 'ODD:C', 'NOCOLON', 'MILESTONE_ORDER:', ':X'])).toEqual([
      { kind: 'MILESTONE_ORDER', code: 'A' },
      { kind: 'REQUIRED_SKIPPED', code: 'B' },
    ]);
  });

  it('counts the evidence a milestone asks for from the documents held, and flags a reached one with none', () => {
    const groups = profile().legal_documents;
    const reached = milestone();
    expect(evidenceOf(reached, groups)).toEqual([{ code: 'INVESTMENT_POLICY_DECISION', held: 21 }]);
    expect(reachedWithoutEvidence(reached, groups)).toBe(false);
    const bare = milestone({ evidence_kinds: ['FS_APPROVAL_DECISION'] });
    expect(evidenceOf(bare, groups)).toEqual([{ code: 'FS_APPROVAL_DECISION', held: 0 }]);
    expect(reachedWithoutEvidence(bare, groups)).toBe(true);
    expect(reachedWithoutEvidence(milestone({ state: 'PLANNED', evidence_kinds: ['FS_APPROVAL_DECISION'] }), groups)).toBe(false);
  });

  it('gives each state of a milestone its tone, and names the two origins of the plan', () => {
    expect(['REACHED', 'PLANNED', 'DELAYED', 'CANCELLED', 'NOT_HELD'].map(milestoneTone)).toEqual(['success', 'info', 'warning', 'danger', 'neutral']);
    expect(isNamedOrigin('GROUP_ASSIGNED')).toBe(true);
    expect(isNamedOrigin('BOARD_APPROVED')).toBe(true);
    expect(isNamedOrigin('OTHER')).toBe(false);
    expect(camel('INVESTMENT_POLICY_DECISION')).toBe('investmentPolicyDecision');
    expect(BUILT_IN_DOC_TYPES).toHaveLength(12);
  });
});

describe('InvestmentProfileScreen (IPF-01): the investment profile of one project', () => {
  it('asks for a project first and reads nothing until one is named', async () => {
    const { reads } = mountWith({ path: '/ipf/ipf-01' });
    await screen.findByTestId('no-project');
    expect(reads).toEqual([]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translator.t('ipf.page.title'));
  });

  it('shows the type, the stage flag with the year it rests on and the plans it was read from', async () => {
    const { reads } = mountWith();
    await screen.findByTestId('fact-type');
    expect(reads[0]?.input).toEqual({ path: { id: PROJECT } });
    expect(screen.getByTestId('fact-type').textContent).toContain('Đầu tư xây dựng cơ bản');
    expect(screen.getByTestId('fact-type').textContent).toContain(translator.t('ipf.kind.capitalWorks.label'));
    expect(screen.getByTestId('fact-flag').textContent).toContain(translator.t('ipf.flag.continuing.label'));
    expect(screen.getByTestId('fact-start').textContent).toContain('2025');
    expect(screen.getByTestId('fact-start').textContent).toContain(translator.t('ipf.basis.actual.label'));
    expect(screen.getByTestId('fact-plans').textContent).toContain('KH-2026');
    expect(screen.getByTestId('fact-plans').textContent).toContain(translator.t('ipf.plan.published.status'));
  });

  it('says that the flag is not known, and that there is no type, no start and no plan, instead of guessing', async () => {
    mountWith({ reply: () => profile({ project_type: null, start_flag: null, start_year: null, start_year_basis: null, plans: [] }) });
    await screen.findByTestId('flag-unknown');
    expect(screen.getByTestId('fact-type').textContent).toContain(translator.t('ipf.class.type.none'));
    expect(screen.getByTestId('fact-start').textContent).toContain(translator.t('ipf.class.start.none'));
    expect(screen.getByTestId('fact-plans').textContent).toContain('2026');
  });

  it('shows a project that starts in the year as a new start, a type without a kind, and a plan without a code', async () => {
    mountWith({
      reply: () => profile({ start_flag: 'NEW_START', start_year: 2026, start_year_basis: 'PLANNED', project_type: { code: 'X', label: 'Loại riêng', kind: null }, plans: [{ plan_code: null, status: 'DRAFT', revision: 1 }] }),
    });
    await screen.findByTestId('fact-flag');
    expect(screen.getByTestId('fact-flag').textContent).toContain(translator.t('ipf.flag.newStart.label'));
    expect(screen.getByTestId('fact-type').textContent).toBe(`${translator.t('ipf.class.type.label')}Loại riêng`);
    expect(screen.getByTestId('fact-plans').textContent).toContain(translator.t('ipf.class.plans.noCode'));
    expect(screen.getByTestId('fact-plans').textContent).toContain(translator.t('ipf.plan.draft.status'));
  });

  it('lists the milestones of the catalogue with their state, days and the evidence they ask for', async () => {
    mountWith();
    const table = await screen.findByRole('table', { name: translator.t('ipf.milestones.caption') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-milestone'))).toEqual(['INVESTMENT_POLICY', 'FS_APPROVAL', 'TMDT_APPROVAL', 'GROUNDBREAKING', 'ACCEPTANCE', 'FINAL_SETTLEMENT']);
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['REACHED', 'REACHED', 'NOT_HELD', 'DELAYED', 'PLANNED', 'CANCELLED']);
    const held = within(rows[0] as HTMLElement).getByText(translator.t('ipf.milestones.evidence.held', { type: 'Quyết định chủ trương đầu tư', count: 21 }));
    expect(held.getAttribute('data-held')).toBe('21');
    // The milestone the project does not hold says so; one that was reached with no document says that too.
    expect(within(rows[2] as HTMLElement).getByText(translator.t('ipf.state.notHeld.label'))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).queryByTestId('no-evidence')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTestId('no-evidence')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(translator.t('ipf.milestones.evidence.missing', { type: translator.t('ipf.docType.fsApprovalDecision.label') }))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByTestId('no-evidence')).toBeNull();
  });

  it('names the order and the skipped required milestone by their labels, and drops a finding of a kind it does not know', async () => {
    mountWith();
    const list = await screen.findByTestId('findings');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-finding'))).toEqual(['MILESTONE_ORDER', 'REQUIRED_SKIPPED']);
    expect(items[0]?.textContent).toBe(translator.t('ipf.findings.order.text', { milestone: 'Phê duyệt báo cáo nghiên cứu khả thi' }));
    expect(items[1]?.textContent).toBe(translator.t('ipf.findings.skipped.text', { milestone: 'Phê duyệt tổng mức đầu tư' }));
  });

  it('says there is no finding when the milestones are in order, and names a milestone that left the catalogue by its code', async () => {
    mountWith({ reply: () => profile({ findings: [] }) });
    expect((await screen.findByTestId('findings-none')).textContent).toBe(translator.t('ipf.findings.none'));
    cleanup();
    mountWith({ reply: () => profile({ findings: ['REQUIRED_SKIPPED:GONE'] }) });
    expect((await screen.findByTestId('findings')).textContent).toContain('GONE');
  });

  it('groups the legal documents by type with the issuer, the purpose, the count and a link to each document', async () => {
    mountWith();
    const groups = await screen.findAllByTestId('legal-group');
    expect(groups.map((group) => group.getAttribute('data-type'))).toEqual(['INVESTMENT_POLICY_DECISION', 'TENANT_OWN_TYPE']);
    const first = within(groups[0] as HTMLElement);
    expect(first.getByText(translator.t('ipf.issuer.group.label'))).toBeTruthy();
    expect(first.getByText(translator.t('ipf.purpose.lifecycleEvidence.label'))).toBeTruthy();
    expect(first.getByTestId('legal-count').textContent).toBe(translator.t('ipf.legal.count.text', { count: 21 }));
    expect(first.getByTestId('legal-more').textContent).toBe(translator.t('ipf.legal.more.text', { shown: 1, count: 21 }));
    expect(first.getByRole('link', { name: 'Quyết định chủ trương' }).getAttribute('href')).toBe(`/doc/doc-25?id=${uuid(40)}`);
    expect(first.getByText(translator.t('ipf.effective.inForce.label'))).toBeTruthy();
    // A type that left the catalogue is shown by its code, with no issuer and no period.
    const second = within(groups[1] as HTMLElement);
    expect(second.queryByTestId('legal-more')).toBeNull();
    expect(second.getByText(translator.t('ipf.effective.undated.label'))).toBeTruthy();
    expect(second.getByText('Văn bản riêng')).toBeTruthy();
  });

  it('says so when the project holds no classified legal document', async () => {
    mountWith({ reply: () => profile({ legal_documents: [] }) });
    expect((await screen.findByTestId('legal-none')).textContent).toBe(translator.t('ipf.legal.none'));
  });

  it('splits the plan by origin: the resolution of the group against the decision of the company, with the documents behind each', async () => {
    mountWith();
    const table = await screen.findByRole('table', { name: translator.t('ipf.origin.caption') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-origin'))).toEqual(['BOARD_APPROVED', 'GROUP_ASSIGNED']);
    expect(within(rows[0] as HTMLElement).getAllByText(translator.t('ipf.origin.boardApproved.label')).length).toBeGreaterThan(0);
    expect(within(rows[0] as HTMLElement).getByText('1.000.000.000')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('12/QD-PVFCCo')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(translator.t('ipf.origin.groupAssigned.label'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('88/NQ-PVN')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('KHAC-1')).toBeTruthy();
    const strip = screen.getByRole('group', { name: translator.t('ipf.origin.strip.label') });
    expect(within(strip).getByText('3.000.000.000')).toBeTruthy();
    expect(within(strip).getByText('2.000.000.000')).toBeTruthy();
  });

  it('shows an origin the pack does not name by its code, and a line with no document as such', async () => {
    mountWith({
      reply: () =>
        profile({
          origin_split: { total_vnd: '5', group_assigned_vnd: '0', board_approved_vnd: '0', other_vnd: '5', origins: [{ origin: 'LEGACY', amount_vnd: '5', lines: 1, decisions: [] }] },
        }),
    });
    const row = await screen.findByText(translator.t('ipf.origin.other.label', { origin: 'LEGACY' }));
    expect(row).toBeTruthy();
    expect(screen.getByTestId('decision-none').textContent).toBe(translator.t('ipf.origin.decisions.none'));
  });

  it('says there is no capital plan line to split when the project has none in the year', async () => {
    mountWith({ reply: () => profile({ origin_split: { total_vnd: '0', group_assigned_vnd: '0', board_approved_vnd: '0', other_vnd: '0', origins: [] } }) });
    expect((await screen.findByTestId('origin-none')).textContent).toBe(translator.t('ipf.origin.none', { year: 2026 }));
  });

  it('reads the plan year of the address and sends it', async () => {
    const { reads } = mountWith({ path: `/ipf/ipf-01?project=${PROJECT}&plan_year=2027`, reply: () => profile({ plan_year: 2027 }) });
    await screen.findByTestId('fact-type');
    expect(reads[0]?.input).toEqual({ path: { id: PROJECT }, query: { plan_year: 2027 } });
    expect(screen.getByLabelText(translator.t('ipf.choose.year.label'))).toHaveProperty('value', '2027');
  });

  it('ignores a plan year of the address that is not a year, so the server answers for the current one', async () => {
    const { reads } = mountWith({ path: `/ipf/ipf-01?project=${PROJECT}&plan_year=abc` });
    await screen.findByTestId('fact-type');
    expect(reads[0]?.input).toEqual({ path: { id: PROJECT } });
  });

  it('offers the projects of the caller, reads the profile of the one chosen with the year typed, and refuses a bad year', async () => {
    const { reads } = mountWith({ path: '/ipf/ipf-01' });
    await screen.findByTestId('no-project');
    const select = screen.getByTestId('project-select') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(within(select).getByRole('option', { name: 'DA-02 · DA-02' })).toBeTruthy();
    const show = screen.getByTestId('show-button') as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    fireEvent.change(select, { target: { value: OTHER } });
    fireEvent.change(screen.getByTestId('year-input'), { target: { value: '27' } });
    expect(screen.getByTestId('year-problem').textContent).toBe(translator.t('ipf.choose.year.format'));
    expect(show.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('year-input'), { target: { value: '1999' } });
    expect(screen.getByTestId('year-problem').textContent).toBe(translator.t('ipf.choose.year.range'));
    fireEvent.change(screen.getByTestId('year-input'), { target: { value: '2027' } });
    expect(screen.queryByTestId('year-problem')).toBeNull();
    fireEvent.click(show);
    await screen.findByTestId('fact-type');
    expect(reads[0]?.input).toEqual({ path: { id: OTHER }, query: { plan_year: 2027 } });
  });

  it('opens the profile with no year typed, and does nothing when the form is sent with no project', async () => {
    const { reads } = mountWith({ path: '/ipf/ipf-01' });
    await screen.findByTestId('no-project');
    fireEvent.submit(screen.getByRole('form', { name: translator.t('ipf.choose.aria') }));
    expect(reads).toEqual([]);
    await waitFor(() => expect(within(screen.getByTestId('project-select')).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(screen.getByTestId('project-select'), { target: { value: PROJECT } });
    fireEvent.click(screen.getByTestId('show-button'));
    await screen.findByTestId('fact-type');
    expect(reads[0]?.input).toEqual({ path: { id: PROJECT } });
  });

  it('says a project outside the scope is not found, without telling whether it exists', async () => {
    mountWith({ reply: () => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) });
    expect((await screen.findByTestId('project-not-found')).textContent).toBe(translator.t('ipf.empty.notFound'));
    expect(screen.queryByTestId('fact-type')).toBeNull();
  });

  it('shows the standard states for a refusal and for a failure, with a retry that reads again', async () => {
    mountWith({ reply: () => new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' }) });
    expect((await screen.findByRole('alert')).textContent).toContain(translator.t('states.denied.title'));
    cleanup();
    const { reads } = mountWith({ reply: () => new Error('boom') });
    await screen.findByText(translator.t('states.error.title'));
    const before = reads.length;
    fireEvent.click(screen.getByRole('button', { name: translator.t('states.retry.action') }));
    await waitFor(() => expect(reads.length).toBeGreaterThan(before));
  });

  it('still opens the profile when the list of projects cannot be read, and says so', async () => {
    mountWith({ projects: new Error('list failed') });
    await screen.findByTestId('fact-type');
    expect((await screen.findByTestId('projects-failed')).textContent).toBe(translator.t('ipf.choose.projects.failed'));
    expect(screen.getAllByText(PROJECT.slice(0, 8)).length).toBeGreaterThan(0);
  });

  it('is read in English with the same facts', async () => {
    translator.setLocale('en');
    mountWith();
    await screen.findByTestId('fact-type');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Investment profile of a project');
    expect(screen.getByTestId('fact-flag').textContent).toContain('Carry-over');
  });
});
