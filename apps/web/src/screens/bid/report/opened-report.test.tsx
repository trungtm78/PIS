import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportScreen from './ReportScreen';
import { EVALUATOR, client, mount, report, reportId, routeOf, world } from './test-support';

const ROUTE = routeOf('BID-13', 'FR-BID-13');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BID-13 a link to one evaluation report (getEvaluationReport)', () => {
  it('reads that report alone when no package is chosen, and tells the person what they see', async () => {
    const h = client(world());
    h.read.mockImplementation((operation: string) => (operation === 'getEvaluationReport' ? Promise.resolve(report(1)) : Promise.reject(new Error(`unexpected read ${operation}`))));
    mount(<ReportScreen route={ROUTE} />, h, { permissions: EVALUATOR, path: `/bid/bid-13?report=${reportId(1)}` });
    expect(await screen.findByTestId('opened-report')).toBeTruthy();
    expect(screen.queryByTestId('choose-package')).toBeNull();
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getEvaluationReport', { path: { id: reportId(1) } }));
    expect(h.read).not.toHaveBeenCalledWith('listEvaluationReports', expect.anything());
  });

  it('shows a report that is not there for the caller (a 404) as an empty answer, never as an error', async () => {
    const h = client(world());
    h.read.mockImplementation(() => Promise.reject(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })));
    mount(<ReportScreen route={ROUTE} />, h, { permissions: EVALUATOR, path: `/bid/bid-13?report=${reportId(1)}` });
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    expect(screen.queryByTestId('reports')?.children.length ?? 0).toBe(0);
  });

  it('asks for the package when the link is not an identifier', async () => {
    const h = client(world());
    mount(<ReportScreen route={ROUTE} />, h, { permissions: EVALUATOR, path: '/bid/bid-13?report=not-an-id' });
    expect(await screen.findByTestId('choose-package')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalledWith('getEvaluationReport', expect.anything());
  });
});
