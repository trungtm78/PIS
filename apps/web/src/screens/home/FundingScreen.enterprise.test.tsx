import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { PUBLIC_BUNDLE } from '../../editions/edition';
import { enterpriseBundle } from '../../editions/enterprise';
import { translator } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import FundingScreen from './FundingScreen';

// The funding structure screen is the public one unless the edition brings its own through the slot; this test names the enterprise bundle, so it carries `.enterprise.` in its name.
const OVERVIEW = routeOf('HOME-07', 'FR-HOME-07');
afterEach(cleanup);

const structure = {
  snapshot_id: 's-1',
  as_of_date: '2026-10-31',
  revision: 1,
  company: {},
  units: [],
  projects: [],
  structure: { measure: 'DISBURSED', plan_total_vnd: '100000000000', disbursed_total_vnd: '40000000000', classes: [{ class_code: 'EQUITY', plan_vnd: '100000000000', disbursed_vnd: '40000000000', plan_share_pct: '100.0000', disbursed_share_pct: '100.0000', rate_pct: '40.0000', null_reason: null }] },
};

describe('HOME-07 through the slot of the edition', () => {
  it('the enterprise edition draws the structure of equity, loan and other from the snapshot, not the public sources', async () => {
    const h = harness((operation) => (operation === 'getLeaderRates' ? structure : new Error(`unexpected read ${operation}`)));
    mount(
      <EditionProvider edition={enterpriseBundle}>
        <FundingScreen route={OVERVIEW} />
      </EditionProvider>,
      h,
      { permissions: ['home.read'] },
    );
    expect(await screen.findByTestId('structure-EQUITY')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translator.t('ent.funding.page.title'));
    expect(screen.queryByTestId('funding-sources')).toBeNull();
  });

  it('the public edition keeps its own screen: the register of the appropriations is read and the leader snapshot is not', async () => {
    const reads: string[] = [];
    const h = harness((operation) => {
      reads.push(operation);
      return new Error(`unexpected read ${operation}`);
    });
    (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => Promise.resolve([]);
    mount(
      <EditionProvider edition={PUBLIC_BUNDLE}>
        <FundingScreen route={OVERVIEW} />
      </EditionProvider>,
      h,
      { permissions: ['capital.read'] },
    );
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translator.t('home.funding.page.title'));
    expect(reads).not.toContain('getLeaderRates');
  });
});
