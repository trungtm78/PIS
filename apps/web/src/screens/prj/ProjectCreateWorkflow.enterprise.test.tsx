import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { installEdition, resetEdition } from '../../editions/edition';
import { enterpriseBundle } from '../../editions/enterprise';
import vi_ from '../../i18n/vi.json';
import ProjectCreateScreen from './ProjectCreateScreen';
import { MAKER, client, mount, routeOf, world } from './test-support';

// PRJ-02 in the enterprise edition is the screen it was: the section "kind of workflow" belongs to the public edition (PWF-4, R48).
const ROUTE = routeOf('PRJ-02', 'FR-PRJ-02');

afterEach(() => {
  cleanup();
  resetEdition();
});

describe('ProjectCreateScreen (PRJ-02) in the enterprise edition', () => {
  it('shows no section for the kind of workflow and never asks for a suggestion, even for a person who may read and start workflows', async () => {
    installEdition(enterpriseBundle);
    const h = client(world());
    mount(
      <EditionProvider edition={enterpriseBundle}>
        <ProjectCreateScreen route={ROUTE} />
      </EditionProvider>,
      h,
      { permissions: [...MAKER, 'pwf.read', 'pwf.workflow.manage'] },
    );
    await waitFor(() => expect(within(screen.getByLabelText(vi_['prj.form.owner.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    expect(screen.queryByTestId('process-kind')).toBeNull();
    expect(h.read.mock.calls.some((call) => call[0] === 'suggestProjectWorkflow')).toBe(false);
  });
});
