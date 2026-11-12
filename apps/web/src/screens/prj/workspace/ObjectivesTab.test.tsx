import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectView } from '../model';
import { client, mount, word, world } from '../test-support';
import ObjectivesTab from './ObjectivesTab';
import { decisionStep, proposalStep, toStageHistory } from './obj-hooks';

afterEach(cleanup);

const PROJECT_ID = '00000000-0000-4000-8000-000000000e01';

const project = {
  id: PROJECT_ID,
  code: 'DA-2026-001',
  name: 'Dự án số 1',
  status: 'IMPLEMENTATION',
  area: { versionId: 'a', businessKey: 'AREA', label: 'Khu kho cảng' },
  sector: { versionId: 's', businessKey: 'SECTOR', label: 'Môi trường' },
  projectType: { versionId: 'p', businessKey: 'NEW', label: 'Đầu tư xây dựng mới' },
  program: null,
  classification: 'INTERNAL',
  projectGroup: 'B',
  totalInvestmentVnd: '681000000000',
  startYear: 2026,
  endYear: 2029,
  appraisalScore: '83.00',
  proposedOn: '2026-11-10',
  suggestion: { groupKey: 'B', sectorKey: null, asOf: '2026-11-10', ruleRevision: 1, legalBasis: 'Căn cứ thử nghiệm', awaitingConfirmation: true, cxn: null },
} as unknown as ProjectView;

const lifecycle = {
  project_id: PROJECT_ID,
  code: 'DA-2026-001',
  status: 'IMPLEMENTATION',
  version: 6,
  history: [
    { from: 'CONCEPT', to: 'APPRAISAL', operation: 'submitProjectForAppraisal', actor_name: 'Phạm Quốc Dũng', decision_document_id: 'd1', reason: 'Hồ sơ đủ điều kiện thẩm định', occurred_at: '2026-11-10T05:03:59Z' },
    { from: 'APPRAISAL', to: 'PIPELINE', operation: 'decideProjectAppraisal', actor_name: 'Trần Thị Bích', decision_document_id: 'd2', reason: 'Đủ điều kiện đưa vào danh mục', occurred_at: '2026-11-11T05:03:59Z' },
  ],
  appraisal: {
    round: 1,
    viewer_is_proposer: true,
    can_record: false,
    can_decide: false,
    criteria_set: {
      version_id: 'v',
      key: 'APPR-1',
      revision: 1,
      legal_basis: 'cơ sở',
      awaiting_confirmation: false,
      pass_threshold: '60',
      criteria: [
        { code: 'FEAS', name: 'Tính khả thi', weight: '60' },
        { code: 'RISK', name: 'Rủi ro', weight: '40' },
      ],
    },
    sheets: [{ id: 's1', version: 1, status: 'DECIDED', mine: false, appraiser: { display_name: 'A' }, scores: [{ criterion_code: 'FEAS', score: 4 }, { criterion_code: 'RISK', score: 3 }], total_score: '72.00', recommendation: 'ADMIT', decision: 'ADMIT' }],
    summary: { sheet_count: 1, mean_score: '72.00', threshold_recommendation: 'ADMIT' },
  },
};

const revisions = {
  items: [
    {
      id: 'r1',
      revision: 2,
      change_kind: 'ADJUST_INVESTMENT',
      status: 'APPROVED',
      before: {},
      after: {},
      total_investment_vnd: '700000000000',
      reason: 'x',
      decision_document: { id: 'doc1', title: 'Quyết định điều chỉnh', symbol: '45/QĐ-TCT', issued_on: '2026-10-01' },
      effective_from: '2026-10-05',
      created_by: { membership_id: 'm', display_name: 'A' },
      version: 1,
    },
  ],
  current_total_investment_vnd: '700000000000',
};

const effectiveness = {
  project: { id: PROJECT_ID, code: 'DA-2026-001', name: 'Dự án số 1', status: 'IMPLEMENTATION' },
  policy: { params: {} },
  fixed: {
    id: 't1',
    version_no: 1,
    status: 'FIXED',
    basis: 'Quyết định đầu tư',
    indicators: [{ id: 'i1', code: 'CAP', name: 'Công suất nước làm mát', unit: 'm3/h', direction: 'HIGHER_IS_BETTER', baseline_value: '100', target_value: '150', variance: { band: 'NOT_MEASURED', basis: 'NONE' } }],
  },
  draft: null,
  superseded: [],
  measurements: [],
  calendar: [],
  assessments: [],
  can: {},
  as_of: '2026-11-10',
};

type Answer = unknown | Error;

function harness(reads: { lifecycle?: Answer; revisions?: Answer; effectiveness?: Answer }) {
  const h = client(world());
  const answer = (value: Answer, fallback: unknown): Promise<unknown> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback));
  h.read.mockImplementation((operation: string) => {
    switch (operation) {
      case 'getProjectLifecycle':
        return answer(reads.lifecycle, { project_id: PROJECT_ID, code: 'DA-2026-001', status: 'CONCEPT', version: 1, history: [] });
      case 'listProjectRevisions':
        return answer(reads.revisions, { items: [], current_total_investment_vnd: '0' });
      case 'getProjectEffectiveness':
        return answer(reads.effectiveness, new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }));
      default:
        return Promise.reject(new Error(`unexpected read ${operation}`));
    }
  });
  return h;
}

describe('ObjectivesTab (PRJ-03, tab Objectives)', () => {
  it('shows the scope, the targets, the proposal, the appraisal and the legal dossier of the project', async () => {
    mount(<ObjectivesTab project={project} />, harness({ lifecycle, revisions, effectiveness }), { permissions: undefined });
    const scope = await screen.findByTestId('obj-scope');
    expect(within(scope).getByText('Môi trường')).toBeTruthy();
    expect(within(scope).getByText('Khu kho cảng')).toBeTruthy();
    expect(screen.getByTestId('obj-basis').textContent).toContain('Căn cứ thử nghiệm');
    expect(await within(await screen.findByTestId('obj-targets')).findByText(/Công suất nước làm mát/)).toBeTruthy();
    const proposal = await screen.findByTestId('obj-proposal');
    await waitFor(() => expect(within(proposal).getByText('Phạm Quốc Dũng')).toBeTruthy());
    expect(within(proposal).getByText('2026-11-10')).toBeTruthy();
    const appraisal = await screen.findByTestId('obj-appraisal');
    await waitFor(() => expect(within(appraisal).getByText('Tính khả thi')).toBeTruthy());
    expect(within(appraisal).getByText(/83\.00/)).toBeTruthy();
    expect(within(appraisal).getByText(/Trần Thị Bích/)).toBeTruthy();
    expect(within(appraisal).getByText('Đủ điều kiện đưa vào danh mục')).toBeTruthy();
    expect(within(appraisal).getByText('3.0')).toBeTruthy();
    const dossier = await screen.findByTestId('obj-dossier');
    await waitFor(() => expect(within(dossier).getByText(/45\/QĐ-TCT/)).toBeTruthy());
    expect(screen.getByTestId('obj-dossier-link').getAttribute('href')).toBe(`/prj/prj-04?id=${PROJECT_ID}`);
    expect(screen.getByTestId('obj-targets-link').getAttribute('href')).toBe(`/mne/mne-11?id=${PROJECT_ID}`);
  });

  it('says in words that an idea-stage project has no proposal, appraisal, targets or documents', async () => {
    const idea = { ...project, status: 'CONCEPT', appraisalScore: null, suggestion: null } as unknown as ProjectView;
    mount(<ObjectivesTab project={idea} />, harness({}), { permissions: undefined });
    expect(await screen.findByText(word('prj.wsTab.obj.targets.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.obj.proposal.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.obj.appraisal.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.obj.dossier.empty'))).toBeTruthy();
    expect(screen.getByText(word('prj.wsTab.obj.scope.noSuggestion'))).toBeTruthy();
  });

  it('shows the denied state in the section whose read is refused and keeps the others', async () => {
    const refused = new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c', extensions: {} });
    mount(<ObjectivesTab project={project} />, harness({ lifecycle: refused, revisions, effectiveness: new Error('boom') }), { permissions: undefined });
    const proposal = await screen.findByTestId('obj-proposal');
    await waitFor(() => expect(within(proposal).getByText(word('states.denied.title'))).toBeTruthy());
    const targets = await screen.findByTestId('obj-targets');
    await waitFor(() => expect(within(targets).getByText(word('states.error.title'))).toBeTruthy());
    await waitFor(() => expect(within(screen.getByTestId('obj-dossier')).getByText(/45\/QĐ-TCT/)).toBeTruthy());
  });
});

describe('stage history of the lifecycle read', () => {
  it('finds the proposal and the latest decision, and drops malformed steps', () => {
    const history = toStageHistory({ history: [...lifecycle.history, { from: 'A' }, null] });
    expect(history).toHaveLength(2);
    expect(proposalStep(history)?.actorName).toBe('Phạm Quốc Dũng');
    expect(decisionStep(history)?.to).toBe('PIPELINE');
    expect(decisionStep(history)?.hasDecisionDocument).toBe(true);
    expect(toStageHistory(undefined)).toEqual([]);
  });
});
