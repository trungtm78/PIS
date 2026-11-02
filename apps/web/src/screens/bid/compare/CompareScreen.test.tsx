import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import CompareScreen from './CompareScreen';
import { CV1, CV2, EVALUATOR, NOBODY, cell, client, compared, comparison, criterion, decided, excluded, mount, packageId, problem, proposalId, routeOf, runId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-10', 'FR-BID-10');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; path?: string } = {}) {
  const h = client(state);
  mount(<CompareScreen route={ROUTE} />, h, { permissions: options.permissions ?? EVALUATOR, path: options.path ?? `/bid/bid-10?package=${packageId(1)}` });
  return h;
}
const columns = (): string[] => Array.from(document.querySelectorAll('thead th[data-proposal]')).map((th) => th.getAttribute('data-proposal') as string);
const rowOf = (code: string): HTMLElement => document.querySelector(`[data-criterion="${code}"]`) as HTMLElement;

describe('CompareScreen (BID-10): the comparison of the proposals of a package', () => {
  describe('the standard states of the screen', () => {
    it('UI-BID-10: shows the loading state, then the table with its caption, its criteria and the version of the criteria used', async () => {
      const h = open(world());
      expect(screen.getByRole('status', { busy: true })).toBeTruthy();
      expect(await screen.findByTestId('comparison')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.compare.page.title']);
      expect(screen.getByRole('table').querySelector('caption')?.textContent).toBe(text('bid.compare.table.caption', { package: 'GT-1' }));
      expect(screen.getByTestId('version-used').textContent).toBe(text('bid.compare.version.used', { id: CV2, status: 'APPROVED' }));
      expect(screen.getByText(text('bid.compare.footer.reference', { id: 'BID-10', req: 'FR-BID-10' }))).toBeTruthy();
      expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(h.read).toHaveBeenCalledWith('compareProposals', { path: { id: packageId(1) }, query: {} });
    });

    it('UI-BID-10: says that no package is chosen, offers the packages and reads no comparison', async () => {
      const h = open(world(), { path: '/bid/bid-10' });
      expect((await screen.findByTestId('no-package')).textContent).toBe(vi_['bid.compare.package.none']);
      expect(h.read).not.toHaveBeenCalled();
      await waitFor(() => expect(document.querySelectorAll('#compare-package option')).toHaveLength(3));
      expect(document.querySelectorAll('#compare-package option')[1]?.textContent).toContain('GT-1');
      cleanup();
      const h2 = open(world(), { path: '/bid/bid-10?package=not-an-identity' });
      expect(await screen.findByTestId('no-package')).toBeTruthy();
      expect(h2.read).not.toHaveBeenCalled();
    });

    it('UI-BID-10: shows the empty state of a package with no proposal, and the error, offline and signed-out states', async () => {
      open(world({ comparison: comparison({ proposals: [], rows: [], excluded: [] }) }));
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(document.getElementById('compare-version')).toBeTruthy();
      cleanup();
      const state = world();
      state.failing.set('compareProposals', new Error('down'));
      open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('comparison')).toBeTruthy();
      for (const [failure, title] of [
        [problem(NETWORK_ERROR_CODE, 0), 'states.offline.title'],
        [problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
        [problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ] as const) {
        cleanup();
        const failing = world();
        failing.failing.set('compareProposals', failure);
        open(failing);
        expect(await screen.findByText(vi_[title])).toBeTruthy();
      }
    });

    it('UI-BID-10: shows the denied state to a caller who is not in the evaluation team, and reads nothing for them, not even the packages', async () => {
      const h = open(world(), { permissions: NOBODY });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      expect((h.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll).not.toHaveBeenCalled();
      expect(screen.queryByTestId('comparison')).toBeNull();
    });

    it('says there is no such package for a caller who does not evaluate its project, names the declaration of one who owes it, and a version that is not of the package', async () => {
      for (const [failure, testId, key] of [
        [problem('RESOURCE_NOT_FOUND', 404), 'package-notFound', 'bid.compare.package.notFound'],
        [problem('CONFLICT_UNDECLARED', 403), 'package-undeclared', 'bid.compare.package.undeclared'],
        [problem('VALIDATION_FAILED', 422), 'package-version', 'bid.compare.version.notOfPackage'],
      ] as const) {
        const state = world();
        state.failing.set('compareProposals', failure);
        open(state);
        expect((await screen.findByTestId(testId)).textContent).toBe(vi_[key]);
        expect(screen.queryByText(vi_['states.denied.title'])).toBeNull();
        expect(screen.queryByTestId('comparison')).toBeNull();
        cleanup();
      }
    });

    it('does not take the screen down when the list of the packages cannot be read: the package of the address is still compared', async () => {
      const state = world();
      state.failing.set('get_resources_procurement_package', new Error('down'));
      open(state);
      expect(await screen.findByTestId('comparison')).toBeTruthy();
    });
  });

  describe('the comparison', () => {
    it('AC-ST-BID-010-2, UAT-AC17: compares the proposals of the criteria asked for, leaves out the one that ran on other criteria as CRITERIA_VERSION_MISMATCH, and lists the attributes that are never compared', async () => {
      const h = open(world(), { path: `/bid/bid-10?package=${packageId(1)}&criteria_version_id=${CV2}` });
      await screen.findByTestId('comparison');
      expect(h.read).toHaveBeenCalledWith('compareProposals', { path: { id: packageId(1) }, query: { criteria_version_id: CV2 } });
      expect(columns()).toEqual([proposalId(1), proposalId(2)]);
      const left = document.querySelector(`[data-excluded="${proposalId(3)}"]`) as HTMLElement;
      expect(left.getAttribute('data-reason')).toBe('CRITERIA_VERSION_MISMATCH');
      expect(within(left).getByTestId('excluded-reason').textContent).toBe(vi_['bid.compare.excluded.mismatch']);
      expect(within(left).getByTestId('excluded-version').textContent).toContain(CV1);
      expect(left.textContent).toContain('Công ty nhà thầu 3');
      // The proposal that was left out has no column and no cell.
      expect(document.querySelector(`thead [data-proposal="${proposalId(3)}"]`)).toBeNull();
      const attributes = Array.from(document.querySelectorAll('[data-attribute]')).map((item) => item.getAttribute('data-attribute'));
      expect(attributes).toEqual(['GENDER', 'ETHNICITY', 'RELIGION', 'MARITAL_STATUS', 'AGE', 'ORIGIN', 'LOCAL_PRESENCE']);
      expect(screen.getByTestId('attributes').textContent).toContain(vi_['bid.compare.attribute.gender']);
      expect(screen.getByTestId('attributes').textContent).toContain(vi_['bid.compare.attribute.localPresence']);
    });

    it('names a proposal with no analysis run as left out for that reason, and says when every proposal is in the table', async () => {
      open(world({ comparison: comparison({ excluded: [excluded(3, { reason: 'NO_ANALYSIS_RUN', run_id: null, criteria_version_id: null })] }) }));
      await screen.findByTestId('comparison');
      const left = document.querySelector(`[data-excluded="${proposalId(3)}"]`) as HTMLElement;
      expect(within(left).getByTestId('excluded-reason').textContent).toBe(vi_['bid.compare.excluded.noRun']);
      expect(within(left).queryByTestId('excluded-version')).toBeNull();
      cleanup();
      open(world({ comparison: comparison({ excluded: [] }) }));
      expect((await screen.findByTestId('excluded-none')).textContent).toBe(vi_['bid.compare.excluded.none']);
    });

    it('shows a package where no proposal ran on the criteria as a notice with the proposals that were left out, not as an empty screen', async () => {
      open(world({ comparison: comparison({ proposals: [], rows: [criterion('C1')].map((c) => ({ criterion: c, cells: [] })) }) }));
      expect((await screen.findByTestId('nothing-compared')).textContent).toBe(vi_['bid.compare.table.none']);
      expect(screen.queryByText(vi_['states.empty.title'])).toBeNull();
      expect(screen.getByTestId('excluded')).toBeTruthy();
    });

    it('shows in each cell only what a person decided, and a mark of undecided where nobody did', async () => {
      open(world());
      await screen.findByTestId('comparison');
      const met = within(rowOf('C1')).getAllByTestId('cell')[0] as HTMLElement;
      expect(within(met).getByTestId('decided-status').textContent).toBe(vi_['bid.analysis.findingStatus.supported']);
      expect(within(met).getByTestId('decided-decision').textContent).toBe(vi_['bid.review.decision.accepted']);
      expect(within(met).queryByTestId('decided-score')).toBeNull();
      expect(within(met).getByTestId('risk').textContent).toBe(vi_['bid.compare.risk.none']);
      const scoredCell = within(rowOf('C2')).getAllByTestId('cell')[0] as HTMLElement;
      expect(within(scoredCell).getByTestId('decided-score').textContent).toContain('7.50');
      expect(within(scoredCell).getByTestId('decided-decision').textContent).toBe(vi_['bid.review.decision.acceptedWithChange']);
      for (const code of ['C1', 'C2', 'C3']) {
        const second = within(rowOf(code)).getAllByTestId('cell')[1] as HTMLElement;
        expect(second.getAttribute('data-risk')).toBe('UNDECIDED');
        expect(within(second).getByTestId('undecided').textContent).toBe(vi_['bid.compare.cell.undecided']);
        expect(within(second).queryByTestId('decided-status')).toBeNull();
      }
      expect((within(rowOf('C3')).getAllByTestId('cell')[0] as HTMLElement).getAttribute('data-risk')).toBe('UNDECIDED');
    });

    it('does not take a cell for decided when the server did not say what was decided, whatever risk it says', async () => {
      open(world({ comparison: comparison({ rows: [{ criterion: criterion('C1'), cells: [cell(1, { decided: { status: 'SUPPORTED' }, risk: 'NONE' }), cell(2, { decided: null, risk: 'NONE' })] }] }) }));
      await screen.findByTestId('comparison');
      for (const one of within(rowOf('C1')).getAllByTestId('cell')) expect(one.getAttribute('data-risk')).toBe('UNDECIDED');
    });

    it('tags a cell for what the decision means for the evaluation: a mandatory criterion that is not met, and one that needs attention', async () => {
      open(
        world({
          comparison: comparison({
            rows: [
              { criterion: criterion('C1', { mandatory: true }), cells: [cell(1, { decided: decided('CONTRADICTED', null, 'ACCEPTED_WITH_CHANGE'), risk: 'MANDATORY_NOT_MET' }), cell(2, { decided: decided('MISSING', null), risk: 'ATTENTION' })] },
            ],
            proposals: [compared(1, { mandatory_not_met: 1 }), compared(2)],
          }),
        }),
      );
      await screen.findByTestId('comparison');
      const [first, second] = within(rowOf('C1')).getAllByTestId('cell') as HTMLElement[];
      expect(first?.getAttribute('data-risk')).toBe('MANDATORY_NOT_MET');
      expect(within(first as HTMLElement).getByTestId('risk').textContent).toBe(vi_['bid.compare.risk.mandatoryNotMet']);
      expect(second?.getAttribute('data-risk')).toBe('ATTENTION');
      expect(within(second as HTMLElement).getByTestId('risk').textContent).toBe(vi_['bid.compare.risk.attention']);
      expect(screen.getAllByTestId('summary-mandatory').map((item) => item.textContent)).toEqual(['1', '0']);
    });

    it('says for each proposal how far its criteria are decided and its weighted score only when the experts gave every score', async () => {
      open(world({ comparison: comparison({ proposals: [compared(1, { decided_count: 3, weighted_score: '65.00' }), compared(2, { decided_count: 1 })] }) }));
      await screen.findByTestId('comparison');
      expect(screen.getAllByTestId('summary-decided').map((item) => item.textContent)).toEqual([text('bid.compare.summary.decidedOf', { decided: 3, total: 3 }), text('bid.compare.summary.decidedOf', { decided: 1, total: 3 })]);
      expect(screen.getAllByTestId('summary-weighted').map((item) => item.textContent)).toEqual([text('bid.compare.summary.weightedValue', { score: '65.00' }), vi_['bid.compare.summary.incomplete']]);
    });

    it('UAT-NFR-AI-02: keeps the columns in the order the server gave, ranks nothing, names no winner and offers no award or acceptance of the AI', async () => {
      // The server orders by the names of the contractors; a screen that sorted by score would put the second first.
      open(world({ comparison: comparison({ proposals: [compared(2, { weighted_score: '10.00' }), compared(1, { weighted_score: '90.00' })] }) }));
      await screen.findByTestId('comparison');
      expect(columns()).toEqual([proposalId(2), proposalId(1)]);
      expect(screen.getByTestId('award-notice').textContent).toBe(vi_['bid.compare.page.awardNotice']);
      const table = screen.getByTestId('comparison').textContent as string;
      expect(table).not.toMatch(/xếp hạng #|hạng nhất|tốt nhất|winner|best|rank/i);
      const buttons = screen.queryAllByRole('button').map((button) => button.textContent);
      expect(buttons.filter((name) => /trúng|award|chấp nhận|accept|phê duyệt|approve/i.test(name ?? ''))).toEqual([]);
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('shows the criteria that were not compared because they ask for what nobody may ask, by their rule', async () => {
      open(world({ comparison: comparison({ excluded_criteria: [{ code: 'C9', rule: 'GENDER' }] }) }));
      expect((await screen.findByTestId('excluded-criteria')).textContent).toBe(text('bid.compare.excluded.criteria', { criteria: `C9 (${vi_['bid.compare.attribute.gender']})` }));
      cleanup();
      open(world({ comparison: comparison({ excluded_criteria: [{ code: 'C9', rule: 'NEW_RULE' }], excluded_attributes: ['NEW_RULE'] }) }));
      expect((await screen.findByTestId('excluded-criteria')).textContent).toContain('C9 (NEW_RULE)');
      expect(document.querySelector('[data-attribute="NEW_RULE"]')?.textContent).toBe('NEW_RULE');
    });

    it('links the column of each proposal to its review, carrying the run, the proposal and the package', async () => {
      open(world());
      await screen.findByTestId('comparison');
      const links = screen.getAllByTestId('review-link') as HTMLAnchorElement[];
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        `/bid/bid-12?run=${runId(1)}&proposal=${proposalId(1)}&package=${packageId(1)}`,
        `/bid/bid-12?run=${runId(2)}&proposal=${proposalId(2)}&package=${packageId(1)}`,
      ]);
      expect(links[0]?.textContent).toBe('Công ty nhà thầu 1');
    });
  });

  describe('the choice of the package and of the version of the criteria', () => {
    it('reads the comparison of the package that is chosen, and none while nothing is chosen', async () => {
      const h = open(world(), { path: '/bid/bid-10' });
      await waitFor(() => expect(document.querySelectorAll('#compare-package option')).toHaveLength(3));
      fireEvent.change(document.getElementById('compare-package') as HTMLElement, { target: { value: packageId(2) } });
      await screen.findByTestId('comparison');
      expect(h.read).toHaveBeenCalledWith('compareProposals', { path: { id: packageId(2) }, query: {} });
    });

    it('applies the version of the criteria that is typed, refuses a text that is not an identity without reading, and goes back to the version in force', async () => {
      const h = open(world());
      await screen.findByTestId('comparison');
      const reads = h.read.mock.calls.length;
      fireEvent.change(document.getElementById('compare-version') as HTMLElement, { target: { value: 'CV-2' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.compare.version.apply'] }));
      expect(await screen.findByText(vi_['bid.compare.version.notIdentity'])).toBeTruthy();
      expect(h.read.mock.calls.length).toBe(reads);
      fireEvent.change(document.getElementById('compare-version') as HTMLElement, { target: { value: `  ${CV1.toUpperCase()} ` } });
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.compare.version.apply'] }));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('compareProposals', { path: { id: packageId(1) }, query: { criteria_version_id: CV1 } }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['bid.compare.version.clear'] }));
      await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['compareProposals', { path: { id: packageId(1) }, query: {} }]));
      expect((document.getElementById('compare-version') as HTMLInputElement).value).toBe('');
    });

    it('ignores a version in the address that is not an identity and takes the one in force', async () => {
      const h = open(world(), { path: `/bid/bid-10?package=${packageId(1)}&criteria_version_id=abc` });
      await screen.findByTestId('comparison');
      expect(h.read).toHaveBeenCalledWith('compareProposals', { path: { id: packageId(1) }, query: {} });
      expect(screen.queryByRole('button', { name: vi_['bid.compare.version.clear'] })).toBeNull();
    });
  });
});
