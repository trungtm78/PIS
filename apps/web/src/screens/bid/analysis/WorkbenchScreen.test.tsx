import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import WorkbenchScreen from './WorkbenchScreen';
import { EVALUATOR, NOBODY, calcEvidence, client, documentEvidence, failedRun, finding, mount, problem, routeOf, run, runId, unsupported, versionId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-09', 'FR-BID-09');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[];
  path?: string;
}

function open(state: World, options: Options = {}) {
  const h = client(state);
  mount(<WorkbenchScreen route={ROUTE} />, h, { permissions: options.permissions ?? EVALUATOR, path: options.path ?? `/bid/bid-09?run=${runId(1)}` });
  return h;
}

/** Five findings of a run: four stand on a citation found on its page and one claimed without a source. */
const five = (): World =>
  world({
    runs: [run(1)],
    findings: [
      finding(1),
      finding(2, { status: 'CONTRADICTED', evidence: [documentEvidence(2, { page_index: 17, quote_excerpt: 'chưa được nghiệm thu' })] }),
      finding(3, { evidence: [calcEvidence(3)] }),
      finding(4, { confidence_type: 'CALIBRATED' }),
      unsupported(5),
    ],
  });
const cardOf = (id: string): HTMLElement => document.querySelector(`[data-finding="${id}"]`) as HTMLElement;
const findingIdOf = (n: number): string => `00000000-0000-4000-8000-${'0040'}${String(n).padStart(8, '0')}`;

describe('WorkbenchScreen (BID-09): the evidence workbench of an analysis run', () => {
  describe('the standard states of the screen', () => {
    it('UI-BID-09: shows the loading state, then the findings of the run under the label of an AI proposal', async () => {
      open(five());
      expect(screen.getByRole('status', { busy: true })).toBeTruthy();
      expect(await screen.findByTestId('findings')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.analysis.workbench.title']);
      expect(screen.getByTestId('ai-notice').textContent).toBe(vi_['bid.analysis.workbench.aiNotice']);
      expect(screen.getByText(text('bid.analysis.footer.reference', { id: 'BID-09', req: 'FR-BID-09' }))).toBeTruthy();
    });

    it('UI-BID-09: says that no run is chosen, without reading one', async () => {
      const h = open(five(), { path: '/bid/bid-09' });
      expect((await screen.findByTestId('no-run')).textContent).toBe(vi_['bid.analysis.run.none']);
      expect(h.read).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-notice')).toBeTruthy();
    });

    it('UI-BID-09: shows the empty state of a run with no finding, and the error, offline and signed-out states', async () => {
      open(world({ runs: [failedRun(1)] }));
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      cleanup();
      const state = five();
      state.failing.set('listAnalysisFindings', new Error('down'));
      open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('findings')).toBeTruthy();
      for (const [failure, title] of [
        [problem(NETWORK_ERROR_CODE, 0), 'states.offline.title'],
        [problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
        [problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ] as const) {
        cleanup();
        const failing = five();
        failing.failing.set('listAnalysisFindings', failure);
        open(failing);
        expect(await screen.findByText(vi_[title])).toBeTruthy();
      }
    });

    it('UI-BID-09: shows the denied state to a caller who is not in the evaluation team, and reads nothing for them', async () => {
      const h = open(five(), { permissions: NOBODY });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      expect(screen.queryByTestId('findings')).toBeNull();
    });

    it('UAT-AC14: says there is no such run for a caller who has no view of its proposal, and names the declaration of one who owes it', async () => {
      open(world(), { path: `/bid/bid-09?run=${runId(7)}` });
      expect((await screen.findByTestId('run-not-found')).textContent).toBe(vi_['bid.analysis.run.notFound']);
      expect(screen.queryByTestId('findings')).toBeNull();
      cleanup();
      const owes = five();
      owes.failing.set('listAnalysisFindings', problem('CONFLICT_UNDECLARED', 403));
      open(owes);
      expect((await screen.findByTestId('run-undeclared')).textContent).toBe(vi_['bid.analysis.run.undeclared']);
      expect(screen.queryByText(vi_['states.denied.title'])).toBeNull();
    });
  });

  describe('the findings', () => {
    it('AC-ST-BID-009-2, UAT-AC13: shows four findings with a citation found on its page and the one without a source as NEEDS_REVIEW with the missing-source flag', async () => {
      open(five());
      await screen.findByTestId('findings');
      expect(document.querySelectorAll('[data-finding]')).toHaveLength(5);
      for (const n of [1, 2, 3, 4]) {
        const card = cardOf(findingIdOf(n));
        expect(within(card).queryByTestId('missing-source')).toBeNull();
        expect(within(card).getByTestId('evidence-count').textContent).toBe(text('bid.analysis.finding.evidenceCount', { count: 1 }));
        expect(within(card).getByTestId('verified').textContent).toBe(vi_['bid.analysis.evidence.verified']);
      }
      const lacking = cardOf(findingIdOf(5));
      expect(lacking.getAttribute('data-status')).toBe('NEEDS_REVIEW');
      expect(within(lacking).getByTestId('finding-status').textContent).toBe(vi_['bid.analysis.findingStatus.needsReview']);
      expect(within(lacking).getByTestId('missing-source').textContent).toBe(vi_['bid.analysis.finding.missingSource']);
      expect(within(lacking).getByTestId('no-evidence').textContent).toBe(vi_['bid.analysis.finding.noEvidence']);
      expect(within(lacking).getByTestId('evidence-count').textContent).toBe(text('bid.analysis.finding.evidenceCount', { count: 0 }));
      // No finding that says it is supported or contradicted is shown without a citation found on its page.
      for (const card of Array.from(document.querySelectorAll('[data-finding]')) as HTMLElement[]) {
        if (['SUPPORTED', 'CONTRADICTED'].includes(card.getAttribute('data-status') as string)) expect(within(card).getAllByTestId('verified').length).toBeGreaterThan(0);
      }
    });

    it('shows the page of a citation as the page a person counts (from 1), the words quoted, and a quotation that was not found on its page as not found', async () => {
      const state = five();
      state.findings = [finding(1, { status: 'NEEDS_REVIEW', missing_source: true, evidence_count: 0, evidence: [documentEvidence(1, { page_index: 11, verified_present: false })] }), finding(2, { evidence: [documentEvidence(2, { page_index: 11 })] })];
      open(state);
      await screen.findByTestId('findings');
      const missed = cardOf(findingIdOf(1));
      expect(within(missed).getByTestId('page').textContent).toBe(text('bid.analysis.evidence.page', { page: 12 }));
      expect(within(missed).getByTestId('document').textContent).toBe(text('bid.analysis.evidence.document', { id: versionId(1).slice(0, 8) }));
      expect(within(missed).getByTestId('document').getAttribute('title')).toBe(versionId(1));
      expect(within(missed).getByTestId('quote').textContent).toBe('đã hoàn thành ba cây cầu');
      expect(within(missed).getByTestId('verified').textContent).toBe(vi_['bid.analysis.evidence.notFound']);
      expect(within(missed).getByTestId('missing-source')).toBeTruthy();
      expect(missed.querySelector('[data-evidence]')?.getAttribute('data-verified')).toBe('false');
      expect(cardOf(findingIdOf(2)).querySelector('[data-evidence]')?.getAttribute('data-verified')).toBe('true');
    });

    it('shows a figure computed in code as that figure, with no page and no quotation, and every kind of evidence by its name', async () => {
      const state = five();
      state.findings = [finding(3, { evidence: [calcEvidence(3), { ...calcEvidence(4), calc_ref: { id: 'table-total:v:1:0', kind: 'TABLE_TOTAL', total: '4000' } }, { ...calcEvidence(5), calc_ref: { id: 'bare' } }, { ...documentEvidence(6), kind: 'SCORECARD', page_index: null, quote_excerpt: null }] })];
      open(state);
      await screen.findByTestId('findings');
      const card = cardOf(findingIdOf(3));
      const figures = within(card).getAllByTestId('figure').map((figure) => figure.textContent);
      expect(figures).toEqual([
        text('bid.analysis.evidence.figureTotal', { id: 'price-check', total: '17650000000' }),
        text('bid.analysis.evidence.figureTotal', { id: 'table-total:v:1:0', total: '4000' }),
        text('bid.analysis.evidence.figure', { id: 'bare' }),
      ]);
      expect(within(card).queryByTestId('page')).toBeNull();
      expect(card.textContent).toContain(vi_['bid.analysis.evidenceKind.calc']);
      expect(card.textContent).toContain(vi_['bid.analysis.evidenceKind.scorecard']);
      cleanup();
      const documents = five();
      documents.findings = [finding(1)];
      open(documents);
      await screen.findByTestId('findings');
      expect(cardOf(findingIdOf(1)).textContent).toContain(vi_['bid.analysis.evidenceKind.document']);
    });

    it('UAT-NFR-AI-02: labels every finding as an AI proposal that an expert has to review, and offers no accept action, single or bulk', async () => {
      open(five());
      await screen.findByTestId('findings');
      const labels = screen.getAllByTestId('ai-label');
      expect(labels).toHaveLength(5);
      for (const label of labels) expect(label.textContent).toBe(vi_['bid.analysis.finding.aiLabel']);
      const buttons = screen.queryAllByRole('button').map((button) => button.textContent ?? '');
      expect(buttons.filter((name) => /chấp nhận|accept|duyệt|phê duyệt|approve/i.test(name))).toEqual([]);
      expect(within(screen.getByTestId('findings')).queryAllByRole('button')).toEqual([]);
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('shows the signal of a finding as a kind of signal and never as a percentage', async () => {
      open(five());
      await screen.findByTestId('findings');
      const heuristic = within(cardOf(findingIdOf(1))).getByTestId('confidence').textContent as string;
      expect(heuristic).toBe(text('bid.analysis.finding.signal', { signal: vi_['bid.analysis.confidence.heuristic'] }));
      expect(within(cardOf(findingIdOf(4))).getByTestId('confidence').textContent).toBe(text('bid.analysis.finding.signal', { signal: vi_['bid.analysis.confidence.calibrated'] }));
      expect(heuristic).not.toMatch(/%/);
      expect(screen.getByTestId('findings').textContent).not.toMatch(/\d\s?%/);
      cleanup();
      const none = five();
      none.findings = [finding(1, { confidence_type: 'NONE' })];
      open(none);
      await screen.findByTestId('findings');
      expect(screen.getByTestId('confidence').textContent).toBe(text('bid.analysis.finding.signal', { signal: vi_['bid.analysis.confidence.none'] }));
    });

    it('shows the run above the findings: how it stands, the class of its data, its route, its counts, and the way back to its progress', async () => {
      open(five());
      await screen.findByTestId('findings');
      expect(screen.getByTestId('run-status').textContent).toBe(vi_['bid.analysis.status.awaitingReview']);
      expect(screen.getByTestId('run-facts').textContent).toBe(
        text('bid.analysis.workbench.facts', { classification: vi_['bid.analysis.class.confidential'], route: vi_['bid.analysis.route.domesticHosted'], count: 5, missing: 1 }),
      );
      expect(screen.getByRole('link', { name: vi_['bid.analysis.link.progress'] }).getAttribute('href')).toBe(`/bid/bid-08?run=${runId(1)}`);
    });
  });

  describe('the filters and the pages', () => {
    it('filters by status and by the missing source, and keeps the filters where they are when nothing matches', async () => {
      open(five());
      await screen.findByTestId('findings');
      fireEvent.change(document.getElementById('analysis-finding-missing') as HTMLElement, { target: { value: 'true' } });
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(1));
      expect(cardOf(findingIdOf(5))).toBeTruthy();
      fireEvent.change(document.getElementById('analysis-finding-missing') as HTMLElement, { target: { value: 'false' } });
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(4));
      fireEvent.change(document.getElementById('analysis-finding-status') as HTMLElement, { target: { value: 'MISSING' } });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(document.getElementById('analysis-finding-status')).toBeTruthy();
      expect(document.getElementById('analysis-finding-missing')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.filter.clear'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(5));
    });

    it('takes the filters from the address and ignores what is not a status', async () => {
      open(five(), { path: `/bid/bid-09?run=${runId(1)}&status=CONTRADICTED&missing=false` });
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(1));
      expect((document.getElementById('analysis-finding-status') as HTMLSelectElement).value).toBe('CONTRADICTED');
      cleanup();
      open(five(), { path: `/bid/bid-09?run=${runId(1)}&status=APPROVED&missing=maybe` });
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(5));
      expect(screen.queryByRole('button', { name: vi_['bid.analysis.filter.clear'] })).toBeNull();
    });

    it('reads the findings a page at a time', async () => {
      const state = five();
      state.pageSize = 2;
      open(state);
      await screen.findByTestId('findings');
      expect(document.querySelectorAll('[data-finding]')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.loadMore.action'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(4));
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.loadMore.action'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-finding]')).toHaveLength(5));
      expect(screen.queryByRole('button', { name: vi_['bid.analysis.loadMore.action'] })).toBeNull();
    });
  });
});
