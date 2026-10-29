import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../test-support';
import { mountInSession } from '../../doc/test-support';
import PipelineScreen from './PipelineScreen';
import { DATASET, client, gate, gateId, mapping, mappingId, world } from './test-support';
import type { Harness, World } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = routeOf('DGV-14', 'FR-DGV-14');

function open(state: Partial<World> = {}): Harness & { state: World } {
  const full = world(state);
  const h = client(full);
  mountInSession(<PipelineScreen route={ROUTE} />, h, { permissions: ['data.mapping.read', 'data.catalog.read'] }, '/dgv/dgv-14');
  return { ...h, state: full };
}

const batches = (): string[] => Array.from(document.querySelectorAll('[data-batch]')).map((row) => row.getAttribute('data-batch') as string);
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};

afterEach(() => cleanup());

describe('PipelineScreen (DGV-14): the gate of the pipeline', () => {
  it('UI-DGV-14 / AC-ST-DGV-004-2: shows the batches kept out in quarantine with the reason and the fields that have no confirmed mapping, apart from those applied', async () => {
    open({
      gates: [
        gate(2, {
          outcome: 'QUARANTINED',
          reason: 'MAPPING_NOT_CONFIRMED',
          fields: [
            { source_field: 'so_tien', missing: true },
            { source_field: 'ma_du_an', missing: true },
          ],
          row_count: 12,
        }),
        gate(1),
      ],
      mappings: [mapping(1, { status: 'CONFIRMED' }), mapping(2, { status: 'CONFIRMED' }), mapping(3)],
    });
    await screen.findByTestId('batches');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('dgv.pipeline.title'));
    expect(batches()).toEqual([gateId(2), gateId(1)]);
    const kept = document.querySelector(`[data-batch="${gateId(2)}"]`) as HTMLElement;
    expect(within(kept).getByTestId('outcome').textContent).toBe(word('dgv.pipeline.outcome.quarantined'));
    expect(within(kept).getByTestId('reason').textContent).toBe(`${word('dgv.pipeline.reason.mappingNotConfirmed')}: so_tien, ma_du_an`);
    expect(kept.textContent).toContain('12');
    const applied = document.querySelector(`[data-batch="${gateId(1)}"]`) as HTMLElement;
    expect(within(applied).getByTestId('outcome').textContent).toBe(word('dgv.pipeline.outcome.applied'));
    expect(within(applied).queryByTestId('reason')).toBeNull();
    // The rule of the pipeline is said on the screen; the tiles count what the gate reads and what waits.
    expect(screen.getByText(word('dgv.pipeline.rule'))).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('tile-confirmed')).getByText('2')).toBeTruthy());
    expect(within(screen.getByTestId('tile-waiting')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('tile-quarantined')).getByText('1')).toBeTruthy();
    expect(screen.getByTestId('confirmed-mappings').querySelectorAll('li')).toHaveLength(2);
    expect(Array.from(document.querySelectorAll('[data-testid="confirmed-mappings"] [data-mapping]')).map((item) => item.getAttribute('data-mapping'))).toEqual([mappingId(1), mappingId(2)]);
  });

  it('narrows the batches by outcome and dataset, and links to the mappings of the dataset chosen', async () => {
    const h = open({ gates: [gate(2, { outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED' }), gate(1)] });
    await screen.findByTestId('batches');
    const queries = () => h.read.mock.calls.filter((call) => call[0] === 'listBatchGates').map((call) => (call[1] as { query: Record<string, unknown> }).query);
    expect(queries()[0]).toEqual({ limit: 50 });
    expect(screen.getByTestId('to-mappings').getAttribute('href')).toBe('/dgv/dgv-20');
    pick('pipeline-outcome', 'QUARANTINED');
    await waitFor(() => expect(batches()).toEqual([gateId(2)]));
    expect(queries().at(-1)).toEqual({ limit: 50, outcome: 'QUARANTINED' });
    await waitFor(() => expect(document.querySelector(`#pipeline-dataset option[value="${DATASET.id}"]`)).not.toBeNull());
    pick('pipeline-dataset', DATASET.id);
    await waitFor(() => expect(queries().at(-1)).toEqual({ limit: 50, outcome: 'QUARANTINED', dataset_id: DATASET.id }));
    expect(screen.getByTestId('to-mappings').getAttribute('href')).toBe(`/dgv/dgv-20?dataset=${DATASET.id}`);
  });

  it('reads on when there are more confirmed mappings than a page, and marks the counts as partial until it has them all', async () => {
    open({ mappings: [mapping(3, { status: 'CONFIRMED' }), mapping(2, { status: 'CONFIRMED' }), mapping(1, { status: 'CONFIRMED' })], pageSize: 2 });
    await screen.findByTestId('confirmed-mappings');
    await waitFor(() => expect(within(screen.getByTestId('tile-confirmed')).getByText('2+')).toBeTruthy());
    fireEvent.click(screen.getByTestId('more-confirmed'));
    await waitFor(() => expect(within(screen.getByTestId('tile-confirmed')).getByText('3')).toBeTruthy());
    expect(screen.queryByTestId('more-confirmed')).toBeNull();
    expect(screen.getByTestId('confirmed-mappings').querySelectorAll('li')).toHaveLength(3);
  });

  it('says so when no batch has passed the gate and no mapping is confirmed, and offers a way to read again when the read failed', async () => {
    open();
    expect((await screen.findByTestId('no-batches')).textContent).toBe(word('dgv.pipeline.batches.none'));
    expect(screen.getByTestId('no-confirmed').textContent).toBe(word('dgv.pipeline.confirmed.none'));
    cleanup();
    const failing = world({ failing: new Set(['listBatchGates']) });
    mountInSession(<PipelineScreen route={ROUTE} />, client(failing), { permissions: ['data.mapping.read'] }, '/dgv/dgv-14');
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-batches');
  });
});
