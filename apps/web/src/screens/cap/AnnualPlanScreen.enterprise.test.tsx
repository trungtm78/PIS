import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { installEdition, resetEdition } from '../../editions/edition';
import { enterpriseBundle } from '../../editions/enterprise';
import AnnualPlanScreen from './AnnualPlanScreen';
import { ANNUAL_ID, PLAN_READER, mount, planClient, planLine, planWorld, routeOf } from './plan-test-support';

// CAP-03 on the demo of the enterprise: the local-budget source is named as the equity capital the enterprise counts it as, with the code of the catalogue untouched.
const ROUTE = routeOf('CAP-03', 'FR-CAP-03');
const NSDP = { version_id: '00000000-0000-4000-8000-0000000000e1', business_key: 'NSDP-DTPT', label: 'Vốn đầu tư phát triển ngân sách địa phương', category: 'NSDP' };

afterEach(() => {
  cleanup();
  resetEdition();
});

describe('AnnualPlanScreen (CAP-03) names the local-budget source in enterprise words', () => {
  it('says equity, not the local budget', async () => {
    installEdition(enterpriseBundle);
    mount(
      <EditionProvider edition={enterpriseBundle}>
        <AnnualPlanScreen route={ROUTE} />
      </EditionProvider>,
      planClient(planWorld({ lines: { [ANNUAL_ID]: [planLine(1, { fund_source: NSDP })] } })),
      { permissions: PLAN_READER, path: '/?plan=' + ANNUAL_ID },
    );
    await waitFor(() => expect(document.querySelector('td [data-line-id]')).not.toBeNull());
    const text = document.querySelector('tbody')?.textContent ?? '';
    expect(text).toContain('Vốn chủ sở hữu - đầu tư phát triển');
    expect(text).not.toMatch(/ngân sách địa phương|NSDP-DTPT/iu);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
});
