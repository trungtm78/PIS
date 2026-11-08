import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, mount, routeOf } from '../test-support';
import OverviewScreen from './OverviewScreen';
import { OTHER_PROJECT, PROJECT, overview, progressClient, stage } from './test-support';

const ROUTE = routeOf('LND-01', 'FR-LND-01');
const PATH = `/lnd/lnd-01?project=${PROJECT}`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ready = () => screen.findByTestId('tiles');

describe('OverviewScreen (LND-01): the land clearance of a project', () => {
  it('UI-LND-01: asks for a project first, and reads the overview of the one chosen', async () => {
    const h = progressClient(() => overview());
    mount(<OverviewScreen route={ROUTE} />, h, { permissions: READER, path: '/lnd/lnd-01' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.progress.project.notice']);
    expect(h.read).not.toHaveBeenCalledWith('getLandProgress', expect.anything());
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.progress.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(h.read).toHaveBeenCalledWith('getLandProgress', { path: { id: PROJECT } });
    fireEvent.change(screen.getByLabelText(vi_['lnd.progress.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('AC-ST-LND-010-1, UI-LND-01: shows the counts the server made, the late stage with the unit that executes it, and the sections', async () => {
    mount(<OverviewScreen route={ROUTE} />, progressClient(() => overview()), { permissions: READER, path: PATH });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.overview.page.title']);
    const tile = (id: string) => screen.getByTestId(`tile-${id}`).textContent;
    expect(tile('parcels')).toContain('10');
    expect(tile('households')).toContain('7');
    expect(tile('noticed')).toContain('4 / 10');
    expect(tile('paid')).toContain('2 / 10');
    expect(tile('area')).toContain('18000.00 / 30000.00');
    expect(tile('late')).toContain('1');
    expect(screen.getByTestId('as-of').textContent).toBe(vi_['lnd.overview.asOf.text'].replace('{at}', '2026-10-24T03:00:00.000Z'));
    // Only the late stage is on the list of late stages, with the centre that executes it.
    const late = within(screen.getByTestId('late-stages'));
    expect(document.querySelectorAll('[data-testid="late-stages"] [data-stage-id]')).toHaveLength(1);
    expect(late.getByTestId('executor').textContent).toBe(`Trung tâm phát triển quỹ đất (${vi_['lnd.executor.landFundCentre.label']})`);
    expect(late.getByText(vi_['lnd.stage.inventory.label'])).toBeTruthy();
    expect(late.getByText('KM-0-3')).toBeTruthy();
    expect(late.getByText(vi_['lnd.stageStatus.late.label'])).toBeTruthy();
    expect((late.getByRole('link', { name: vi_['lnd.overview.board.link'] }) as HTMLAnchorElement).getAttribute('href')).toBe(`/lnd/lnd-11?project=${PROJECT}`);
    const sections = within(screen.getByTestId('sections'));
    expect(sections.getByText('KM-0-3 · Km 0 đến km 3')).toBeTruthy();
    expect(sections.getByText('18000.00 / 30000.00')).toBeTruthy();
    expect(within(screen.getByTestId('by-status')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `${vi_['lnd.parcelStatus.surveyed.label']}: 6`,
      `${vi_['lnd.parcelStatus.paid.label']}: 2`,
      `${vi_['lnd.parcelStatus.handedOver.label']}: 2`,
    ]);
    // A household is counted, never named.
    expect(document.body.textContent).not.toMatch(/head_name|national_id/);
  });

  it('says so when no stage is late and the project has no section and no parcel', async () => {
    const empty = overview({
      totals: { sections: 0, parcels: 0, households: 0, late_stages: 0, required_area_m2: '0', handed_area_m2: '0' },
      parcels_by_status: {},
      sections: [],
      stages: [stage(1, { status: 'IN_PROGRESS', blocker_issue_id: null })],
    });
    mount(<OverviewScreen route={ROUTE} />, progressClient(() => empty), { permissions: READER, path: PATH });
    await ready();
    expect(screen.getByTestId('no-late').textContent).toBe(vi_['lnd.overview.late.none']);
    expect(screen.getByTestId('no-sections').textContent).toBe(vi_['lnd.overview.sections.none']);
    expect(screen.queryByTestId('by-status')).toBeNull();
  });

  it('shows the error state when the overview cannot be read, and reads it again on retry', async () => {
    let fail = true;
    const h = progressClient(() => (fail ? new Error('down') : overview()));
    mount(<OverviewScreen route={ROUTE} />, h, { permissions: READER, path: PATH });
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    fail = false;
    fireEvent.click(retry);
    await ready();
    expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reads another project when the choice changes', async () => {
    const seen: string[] = [];
    const h = progressClient((projectId) => {
      seen.push(projectId);
      return overview();
    });
    mount(<OverviewScreen route={ROUTE} />, h, { permissions: READER, path: PATH });
    await ready();
    await screen.findByRole('option', { name: /DA-2026-002/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.progress.project.label']), { target: { value: OTHER_PROJECT } });
    await waitFor(() => expect(seen).toContain(OTHER_PROJECT));
  });
});
