import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directive, page } from '../../dir/test-support';
import { issue } from '../../iss/test-support';
import { client, mount, word, world } from '../test-support';
import type { ProjectView } from '../model';
import IssuesTab from './IssuesTab';

afterEach(cleanup);

const PROJECT_ID = '00000000-0000-4000-8000-000000000e01';
const OTHER_ID = '00000000-0000-4000-8000-000000000e02';
const project = { id: PROJECT_ID, code: 'DA-2026-001', name: 'Dự án số 1' } as unknown as ProjectView;

const risk = {
  id: '00000000-0000-4000-8000-0000000000e1',
  code: 'R-1',
  category_label: 'Giải phóng mặt bằng',
  title: 'Rủi ro chậm mặt bằng',
  description: 'Hộ dân chưa nhận tiền',
  likelihood: 4,
  impact: 5,
  score: 20,
  level: 'CRITICAL',
  owner: { membership_id: 'm', display_name: 'Nguyễn Văn An' },
  mitigation: 'Họp dân hằng tuần',
  due_date: '2099-12-31',
  overdue: false,
  linked_issue_id: null,
  status: 'OPEN',
  closed_reason: null,
  version: 1,
};

const warning = (id: string, projectId: string, name: string) => ({
  id,
  rule: { code: 'EW-01', name, metric_code: null, comparator: null, threshold: null },
  severity: 'CRITICAL',
  status: 'OPEN',
  project: { id: projectId, code: 'DA-2026-001', name: 'Dự án số 1' },
  observed: {},
  snapshot_id: '00000000-0000-4000-8000-000000000f01',
  opened_at: '2026-11-01T02:00:00.000Z',
  version: 1,
});

interface Reads {
  issues?: unknown[] | Error;
  risks?: unknown[] | Error;
  warnings?: unknown[] | Error;
  directives?: unknown[] | Error;
}

function harness(reads: Reads) {
  const h = client(world());
  const answer = (value: unknown[] | Error | undefined): unknown => (value instanceof Error ? value : (value ?? []));
  h.read.mockImplementation((operation: string) => {
    switch (operation) {
      case 'listProjectRisks': {
        const value = answer(reads.risks);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve({ items: value, next_cursor: null, matrix: [], live_count: 1, critical_count: 1, overdue_count: 0 });
      }
      case 'getHomeWarnings': {
        const value = answer(reads.warnings);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve({ items: value, next_cursor: null });
      }
      case 'listDirectives': {
        const value = answer(reads.directives);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(page(value as unknown[]));
      }
      default:
        return Promise.reject(new Error(`unexpected read ${operation}`));
    }
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation !== 'get_resources_issue') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    return reads.issues instanceof Error ? Promise.reject(reads.issues) : Promise.resolve(reads.issues ?? []);
  });
  return h;
}

describe('IssuesTab (PRJ-03, tab Issues): issues, risks, warnings and directives of one project', () => {
  it('shows the data of the project from the four modules and leaves out the issues and warnings of other projects', async () => {
    const h = harness({
      issues: [issue(1, { project_id: PROJECT_ID }), issue(2, { project_id: OTHER_ID, title: 'Vướng mắc của dự án khác' })],
      risks: [risk],
      warnings: [warning('00000000-0000-4000-8000-000000000a01', PROJECT_ID, 'Giải ngân thấp'), warning('00000000-0000-4000-8000-000000000a02', OTHER_ID, 'Cảnh báo dự án khác')],
      directives: [directive(1)],
    });
    mount(<IssuesTab project={project} />, h, { permissions: undefined });
    const issues = await screen.findByTestId('ws-issues');
    await waitFor(() => expect(within(issues).getByText('Chậm bàn giao mặt bằng số 1')).toBeTruthy());
    expect(screen.queryByText('Vướng mắc của dự án khác')).toBeNull();
    expect(within(await screen.findByTestId('ws-risks')).getByText('Rủi ro chậm mặt bằng')).toBeTruthy();
    const warnings = await screen.findByTestId('ws-warnings');
    await waitFor(() => expect(within(warnings).getByText('Giải ngân thấp')).toBeTruthy());
    expect(screen.queryByText('Cảnh báo dự án khác')).toBeNull();
    expect(within(await screen.findByTestId('ws-directives')).getByText('GB-2026-001/CD-01')).toBeTruthy();
    expect(screen.getByTestId('ws-issues-link').getAttribute('href')).toBe('/iss/iss-01');
    expect(screen.getByTestId('ws-risks-link').getAttribute('href')).toBe(`/prj/prj-16?id=${PROJECT_ID}`);
    const directives = h.read.mock.calls.filter(([operation]) => operation === 'listDirectives');
    expect(directives[0]?.[1]).toMatchObject({ query: { project_id: PROJECT_ID } });
  });

  it('says in words that a project has none of them, with the link to the detailed screen kept', async () => {
    mount(<IssuesTab project={project} />, harness({}), { permissions: undefined });
    await waitFor(() => expect(screen.getByText(word('prj.wsTab.iss.issues.empty'))).toBeTruthy());
    expect(await screen.findByText(word('prj.wsTab.iss.risks.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.iss.warnings.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.iss.directives.empty'))).toBeTruthy();
    expect(screen.getByTestId('ws-directives-link')).toBeTruthy();
  });

  it('shows the denied state in the section whose read is refused and keeps the others', async () => {
    const refused = new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c', extensions: {} });
    mount(<IssuesTab project={project} />, harness({ issues: refused, risks: [risk], directives: new Error('boom') }), { permissions: undefined });
    const issues = await screen.findByTestId('ws-issues');
    await waitFor(() => expect(within(issues).getByText(word('states.denied.title'))).toBeTruthy());
    expect(await within(await screen.findByTestId('ws-risks')).findByText('Rủi ro chậm mặt bằng')).toBeTruthy();
    const directives = await screen.findByTestId('ws-directives');
    await waitFor(() => expect(within(directives).getByText(word('states.error.title'))).toBeTruthy());
  });
});
