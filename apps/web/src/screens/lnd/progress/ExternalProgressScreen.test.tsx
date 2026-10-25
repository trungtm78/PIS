import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { OFFICER, READER, SECTION, UNIT_TTQD, mount, routeOf } from '../test-support';
import ExternalProgressScreen from './ExternalProgressScreen';
import { PROJECT, STAGE_DOCUMENT, overview, progressClient, stage } from './test-support';

const ROUTE = routeOf('LND-11', 'FR-LND-11');
const PATH = `/lnd/lnd-11?project=${PROJECT}`;
const REPORTER = ['land.read', 'land.progress.report'];
const OK = { operation_id: 'o', status: 'IN_PROGRESS', resource_version: 4, resource_id: stage(1).id };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-stage-id="${stage(n).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('stages');
const label = (key: string) => screen.getByLabelText(vi_[key as keyof typeof vi_] as string);

describe('ExternalProgressScreen (LND-11): the progress of the stages, tracked from outside', () => {
  it('UI-LND-11: asks for a project first, then lists the stages with their executor, mode, parcels, progress, deadline and status', async () => {
    const h = progressClient(() => overview());
    mount(<ExternalProgressScreen route={ROUTE} />, h, { permissions: REPORTER, path: '/lnd/lnd-11' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.progress.project.notice']);
    expect(screen.queryByRole('button', { name: vi_['lnd.progress.report.action'] })).toBeNull();
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.progress.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['lnd.progress.column.section'],
      vi_['lnd.progress.column.stage'],
      vi_['lnd.progress.column.executor'],
      vi_['lnd.progress.column.mode'],
      vi_['lnd.progress.column.parcels'],
      vi_['lnd.progress.column.progress'],
      vi_['lnd.progress.column.plannedEnd'],
      vi_['lnd.progress.column.status'],
      vi_['lnd.progress.column.action'],
    ]);
    const external = within(rowOf(1));
    expect(external.getByRole('rowheader').textContent).toBe('KM-0-3');
    expect(external.getByText(vi_['lnd.stage.inventory.label'])).toBeTruthy();
    expect(external.getByTestId('executor').textContent).toBe(`Trung tâm phát triển quỹ đất (${vi_['lnd.executor.landFundCentre.label']})`);
    expect(external.getByTestId('mode').textContent).toBe(vi_['lnd.mode.trackedExternal.label']);
    expect(external.getByTestId('parcels').textContent).toBe('45 / 120');
    expect(external.getByTestId('progress').textContent).toBe('37.50%');
    expect(external.getByText('2026-08-31')).toBeTruthy();
    expect(external.getByTestId('status').textContent).toBe(vi_['lnd.stageStatus.late.label']);
    expect(external.getByTestId('evidence').textContent).toBe(vi_['lnd.progress.evidence.text']);
    expect(external.getByTestId('issue').textContent).toBe(vi_['lnd.progress.issue.text']);
    // The stage that LND counts itself is shown and has no way to be reported by hand.
    const native = within(rowOf(2));
    expect(native.getByTestId('mode').textContent).toBe(vi_['lnd.mode.native.label']);
    expect(native.queryByRole('button')).toBeNull();
    expect(external.getByRole('button', { name: vi_['lnd.progress.update.aria'].replace('{stage}', vi_['lnd.stage.inventory.label']).replace('{section}', 'KM-0-3') })).toBeTruthy();
  });

  it('shows the blocker of a blocked stage, and says so when the project has no stage yet but still offers the first report', async () => {
    const blocked = overview({ stages: [stage(1, { status: 'BLOCKED', blocker_issue_id: null, evidence_document_version_id: null, blocker_note: 'Chờ quyết định của huyện' })] });
    mount(<ExternalProgressScreen route={ROUTE} />, progressClient(() => blocked), { permissions: REPORTER, path: PATH });
    await ready();
    expect(within(rowOf(1)).getByTestId('blocker').textContent).toBe('Chờ quyết định của huyện');
    expect(within(rowOf(1)).queryByTestId('evidence')).toBeNull();
    expect(within(rowOf(1)).queryByTestId('issue')).toBeNull();
    cleanup();
    mount(<ExternalProgressScreen route={ROUTE} />, progressClient(() => overview({ stages: [], sections: [] })), { permissions: REPORTER, path: PATH });
    expect((await screen.findByTestId('no-stages')).textContent).toBe(vi_['lnd.progress.empty.notice']);
    expect(screen.getByRole('button', { name: vi_['lnd.progress.report.action'] })).toBeTruthy();
  });

  it('offers no report to a reader, nor in a read-only session', async () => {
    mount(<ExternalProgressScreen route={ROUTE} />, progressClient(() => overview()), { permissions: READER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.progress.report.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
    cleanup();
    mount(<ExternalProgressScreen route={ROUTE} />, progressClient(() => overview()), { permissions: REPORTER, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.progress.report.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
  });

  it('AC-ST-LND-010-1, UI-LND-11: sends the first report of a stage with its evidence, as a tracked stage, and closes', async () => {
    const h = progressClient(() => overview({ stages: [] }), () => OK);
    mount(<ExternalProgressScreen route={ROUTE} />, h, { permissions: REPORTER, path: PATH });
    fireEvent.click(await screen.findByRole('button', { name: vi_['lnd.progress.report.action'] }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'KM-0-3' });
    await waitFor(() => expect(label('lnd.progress.field.executorUnit').querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(label('lnd.progress.field.section'), { target: { value: SECTION } });
    fireEvent.change(label('lnd.progress.field.stage'), { target: { value: 'INVENTORY' } });
    fireEvent.change(label('lnd.progress.field.executorKind'), { target: { value: 'LAND_FUND_CENTRE' } });
    fireEvent.change(label('lnd.progress.field.executorUnit'), { target: { value: UNIT_TTQD } });
    fireEvent.change(label('lnd.progress.field.parcelsTotal'), { target: { value: '120' } });
    fireEvent.change(label('lnd.progress.field.parcelsDone'), { target: { value: '45' } });
    fireEvent.change(label('lnd.progress.field.plannedEnd'), { target: { value: '2026-08-31' } });
    fireEvent.change(label('lnd.progress.field.evidence'), { target: { value: STAGE_DOCUMENT } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'reportLandStageProgress',
      expect.objectContaining({
        body: {
          project_id: PROJECT,
          section_id: SECTION,
          stage_code: 'INVENTORY',
          executor_kind: 'LAND_FUND_CENTRE',
          executor_unit_id: UNIT_TTQD,
          mode: 'TRACKED_EXTERNAL',
          parcels_total: 120,
          parcels_done: 45,
          planned_end: '2026-08-31',
          evidence_document_version_id: STAGE_DOCUMENT,
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('corrects a reported stage: the form starts from the report, the section and the stage cannot change, and the version is not sent as a body', async () => {
    const h = progressClient(() => overview(), () => OK);
    mount(<ExternalProgressScreen route={ROUTE} />, h, { permissions: REPORTER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(vi_['lnd.progress.dialog.update'].replace('{stage}', vi_['lnd.stage.inventory.label']));
    expect((label('lnd.progress.field.parcelsDone') as HTMLInputElement).value).toBe('45');
    expect((label('lnd.progress.field.evidence') as HTMLInputElement).value).toBe(STAGE_DOCUMENT);
    expect((label('lnd.progress.field.section') as HTMLSelectElement).disabled).toBe(true);
    expect((label('lnd.progress.field.stage') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(label('lnd.progress.field.parcelsDone'), { target: { value: '60' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ stage_code: 'INVENTORY', parcels_done: 60, parcels_total: 120 });
  });

  it('judges the form before it sends: more parcels done than the total and a report without evidence stay in the dialog with the reason', async () => {
    const h = progressClient(() => overview({ stages: [] }), () => OK);
    mount(<ExternalProgressScreen route={ROUTE} />, h, { permissions: REPORTER, path: PATH });
    fireEvent.click(await screen.findByRole('button', { name: vi_['lnd.progress.report.action'] }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(await within(dialog).findAllByText(vi_['lnd.progress.field.required'])).toHaveLength(4);
    fireEvent.change(label('lnd.progress.field.parcelsTotal'), { target: { value: '5' } });
    fireEvent.change(label('lnd.progress.field.parcelsDone'), { target: { value: '6' } });
    expect(await within(dialog).findByText(vi_['lnd.progress.field.exceeds'])).toBeTruthy();
    fireEvent.change(label('lnd.progress.field.parcelsDone'), { target: { value: '3' } });
    expect(await within(dialog).findByText(vi_['lnd.progress.field.evidenceRequired'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says what the server refused: a stage counted by LND, a document that is not clean, and keeps the dialog open', async () => {
    const refuse = (code: string) => () => new ApiError({ status: 422, code, correlationId: 'c' });
    for (const [code, key] of [
      ['NATIVE_STAGE_READONLY', 'lnd.progress.problem.native'],
      ['DOCUMENT_NOT_CLEAN', 'lnd.progress.problem.document'],
      ['PARCELS_DONE_EXCEEDS_TOTAL', 'lnd.progress.problem.exceeds'],
      ['SCOPE_DENIED', 'lnd.progress.problem.denied'],
    ] as const) {
      const h = progressClient(() => overview(), refuse(code));
      mount(<ExternalProgressScreen route={ROUTE} />, h, { permissions: REPORTER, path: PATH });
      await ready();
      fireEvent.click(within(rowOf(1)).getByRole('button'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_[key]);
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });

  it('closes the dialog without sending when it is cancelled', async () => {
    const h = progressClient(() => overview(), () => OK);
    mount(<ExternalProgressScreen route={ROUTE} />, h, { permissions: OFFICER.concat('land.progress.report'), path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['lnd.dialog.cancel.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });
});
