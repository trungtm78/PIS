import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { POLICY, directive, overdueDirective, page, summary, uuid } from '../../screens/dir/test-support';
import DirectivesScreen from './DirectivesScreen';
import { useApiDirectives } from './directives-api-source';
import { DirectivesSourceContext } from './directives-source';
import { mountPwa, pwaClient, word } from './test-support';

const UNIT = { id: uuid(101), code: 'BQL1', name: 'Ban quản lý 1', status: 'ACTIVE' };
const failure = new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' });

function open(summaryAnswer: unknown = summary) {
  const h = pwaClient({
    read: (operation, input) => {
      const query = (input as { query?: Record<string, unknown> } | undefined)?.query ?? {};
      if (operation === 'listDirectives') return query.overdue === true ? page([overdueDirective(2)]) : page([directive(1), overdueDirective(2)]);
      if (operation === 'getDirectiveSummary') return summaryAnswer;
      return new Error(`unexpected read ${operation}`);
    },
    readAll: (operation) => (operation === 'get_resources_organization_unit' ? [UNIT] : new Error(`unexpected ${operation}`)),
  });
  mountPwa(
    <DirectivesSourceContext.Provider value={useApiDirectives}>
      <DirectivesScreen />
    </DirectivesSourceContext.Provider>,
    h,
    { path: '/m/directives' },
  );
  return h;
}

afterEach(cleanup);

describe('PWA-04 filters and counts over the real operations', () => {
  it('shows the counts of the scope with the formula of each and flags unconfirmed thresholds', async () => {
    const h = open();
    const tiles = await screen.findByTestId('summary');
    expect(tiles.querySelector('[data-tile="overdue"]')?.textContent).toContain('2');
    expect(tiles.querySelector('[data-tile="dueSoon"]')?.textContent).toContain('2');
    expect(tiles.querySelector('[data-tile="open"]')?.textContent).toContain('5');
    expect(screen.getByTestId('policy-unverified')).toBeInTheDocument();
    expect(tiles.textContent).toContain('Chỉ đạo chưa xong có hạn trong 3 ngày.');
    expect(h.read).toHaveBeenCalledWith('getDirectiveSummary', { query: {} });
  });

  it('asks the server for the overdue ones and for one unit, and counts for that unit (AC-ST-PWA-003-1)', async () => {
    const h = open();
    await screen.findByLabelText(word('pwa.directives.list.aria'));
    fireEvent.click(screen.getByLabelText(word('pwa2.directives.filter.overdue')));
    await waitFor(() => expect(document.querySelectorAll('[data-directive]')).toHaveLength(1));
    expect(h.read).toHaveBeenCalledWith('listDirectives', { query: expect.objectContaining({ overdue: true }) });
    await waitFor(() => expect(screen.getByLabelText(word('pwa2.directives.filter.unit')).querySelectorAll('option').length).toBe(2));
    fireEvent.change(screen.getByLabelText(word('pwa2.directives.filter.unit')), { target: { value: UNIT.id } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDirectives', { query: expect.objectContaining({ unit_id: UNIT.id, overdue: true }) }));
    expect(h.read).toHaveBeenCalledWith('getDirectiveSummary', { query: { unit_id: UNIT.id } });
  });

  it('says the counts could not be read, keeps the list and never shows them as 0', async () => {
    open(failure);
    await screen.findByLabelText(word('pwa.directives.list.aria'));
    expect((await screen.findByTestId('summary-failed')).textContent).toContain(word('pwa2.directives.summary.failed'));
    expect(screen.queryByTestId('summary')).toBeNull();
    expect(POLICY.unverified).toBe(true);
  });
});
