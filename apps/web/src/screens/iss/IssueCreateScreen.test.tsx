import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import IssueCreateScreen from './IssueCreateScreen';
import { READER, REPORTER, category, client, issue, mountIssue, project, routeOf, unit, world } from './test-support';

const ROUTE = routeOf('ISS-02', 'FR-ISS-02');
const CREATED = issue(7);
const problem = (code: string, status = 422, detailText?: string) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions: {} });
const OPENED = { operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: CREATED.id };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const ready = () => waitFor(() => expect(within(screen.getByLabelText(vi_['iss.create.category.label'])).getAllByRole('option').length).toBeGreaterThan(1));
const reporting = (command: (operation: string, input: unknown) => unknown = () => OPENED) =>
  client(world({ projects: [project(1), project(2)], units: [unit(1), unit(2)], categories: [category(1), category(2)] }), command);
const open = (h = reporting(), permissions: readonly string[] | undefined = REPORTER) => mountIssue(<IssueCreateScreen route={ROUTE} />, h, { permissions, path: '/iss/iss-02' });
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['iss.create.submit.action'] }));
};

async function fill(): Promise<void> {
  await ready();
  set(vi_['iss.create.project.label'], project(1).id);
  set(vi_['iss.create.unit.label'], unit(2).id);
  set(vi_['iss.create.category.label'], category(1).version_id);
  set(vi_['iss.create.severity.label'], 'HIGH');
  set(vi_['iss.create.title.label'], '  Chậm bàn giao mặt bằng  ');
  set(vi_['iss.create.description.label'], ' Hộ dân chưa nhận tiền ');
}
const sentBody = (h: ReturnType<typeof reporting>, call = 0) => (h.command.mock.calls[call] as [string, { body: Record<string, unknown> }])[1].body;

describe('IssueCreateScreen (ISS-02): an issue is reported', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: (() => { let n = 0; return () => `00000000-0000-4000-8000-0000000000${String(++n).padStart(2, '0')}`; })() });
  });

  it('shows the fields of the screen with the projects, the units and the categories to choose from, and the rules that apply (UI-ISS-02)', async () => {
    open();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iss.create.page.title']);
    const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);
    expect(options(vi_['iss.create.project.label'])).toEqual([vi_['iss.create.choose.option'], 'DA-2026-001 · Dự án số 1', 'DA-2026-002 · Dự án số 2']);
    expect(options(vi_['iss.create.unit.label'])).toEqual([vi_['iss.create.choose.option'], 'UBND-1 · Ủy ban nhân dân 1', 'UBND-2 · Ủy ban nhân dân 2']);
    expect(options(vi_['iss.create.category.label'])).toEqual([vi_['iss.create.choose.option'], 'GPMB-1 · Giải phóng mặt bằng 1', 'GPMB-2 · Giải phóng mặt bằng 2']);
    expect(options(vi_['iss.create.severity.label'])).toEqual(['Thấp', 'Trung bình', 'Cao', 'Nghiêm trọng']);
    expect(screen.getByTestId('source').textContent).toContain(vi_['iss.source.manual.text']);
    expect(screen.getByText(vi_['iss.create.sla.text'])).toBeTruthy();
    expect(screen.getByText(vi_['iss.create.offline.text'])).toBeTruthy();
    expect(screen.getByText(vi_['iss.create.photo.notice'])).toBeTruthy();
  });

  it('names what is missing or too long and sends nothing', async () => {
    const h = reporting();
    open(h);
    await ready();
    submit();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['iss.field.required.error']]));
    expect(screen.getByLabelText(vi_['iss.create.title.label']).getAttribute('aria-invalid')).toBe('true');
    set(vi_['iss.create.title.label'], 'x'.repeat(201));
    expect(screen.getByLabelText(vi_['iss.create.title.label']).getAttribute('aria-invalid')).toBe('false');
    submit();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.tooLong.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('reports the issue with what was typed and the operation id of the intention, then offers its workspace', async () => {
    const h = reporting();
    open(h);
    await fill();
    submit();
    await screen.findByTestId('created');
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command.mock.calls[0]?.[0]).toBe('createIssue');
    expect(sentBody(h)).toEqual({
      project_id: project(1).id,
      category_version_id: category(1).version_id,
      severity: 'HIGH',
      title: 'Chậm bàn giao mặt bằng',
      description: 'Hộ dân chưa nhận tiền',
      owner_unit_id: unit(2).id,
      client_operation_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(screen.getByRole('link', { name: vi_['iss.create.done.open'] }).getAttribute('href')).toBe(`/iss/iss-03?id=${CREATED.id}`);
    expect((screen.getByRole('button', { name: vi_['iss.create.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the operation id when the answer is lost, so that sending again is the same issue, and takes a new one after a refusal (UAT-AC355)', async () => {
    const h = reporting();
    h.command
      .mockRejectedValueOnce(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }))
      .mockRejectedValueOnce(problem('SLA_POLICY_MISSING'))
      .mockResolvedValueOnce(OPENED);
    open(h);
    await fill();
    submit();
    await waitFor(() => expect(screen.getByTestId('problem')).toBeTruthy());
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.noPolicy.error']));
    submit();
    await screen.findByTestId('created');
    const operations = [0, 1, 2].map((call) => sentBody(h, call).client_operation_id);
    expect(operations[0]).toBe(operations[1]);
    expect(operations[2]).not.toBe(operations[1]);
  });

  it('says what the server refused: no policy, a duplicate source, a field it names, a denial', async () => {
    const h = reporting();
    h.command.mockRejectedValueOnce(problem('VALIDATION_FAILED', 422, 'category_version_id')).mockRejectedValueOnce(problem('SCOPE_DENIED', 403)).mockRejectedValueOnce(problem('DUPLICATE_SOURCE_OPEN', 409)).mockRejectedValueOnce(new Error('boom'));
    open(h);
    await fill();
    submit();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.validation.error']));
    expect(screen.getByLabelText(vi_['iss.create.category.label']).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.rejected.error']);
    submit();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.denied.error']));
    submit();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.duplicateSource.error']));
    submit();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.general.error']));
    // Changing a field clears the refusal.
    set(vi_['iss.create.title.label'], 'Another title');
    expect(screen.queryByTestId('problem')).toBeNull();
  });

  describe('the position', () => {
    it('needs the consent before it is typed, sends it with the consent, and takes it back when the consent is taken back (UAT-AC355)', async () => {
      const h = reporting();
      open(h);
      await fill();
      expect((screen.getByLabelText(vi_['iss.create.geo.lat.label']) as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: vi_['iss.create.geo.locate.action'] }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByLabelText(vi_['iss.create.geo.consent.label']));
      set(vi_['iss.create.geo.lat.label'], '10.8');
      set(vi_['iss.create.geo.lng.label'], '106.7');
      set(vi_['iss.create.geo.accuracy.label'], '12');
      fireEvent.click(screen.getByLabelText(vi_['iss.create.geo.consent.label']));
      expect((screen.getByLabelText(vi_['iss.create.geo.lat.label']) as HTMLInputElement).value).toBe('');
      submit();
      await screen.findByTestId('created');
      expect(sentBody(h)).not.toHaveProperty('geo_lat');
      expect(sentBody(h)).not.toHaveProperty('geo_consent');
    });

    it('sends the position with the consent that stores it, and refuses a position that is not one', async () => {
      const h = reporting();
      open(h);
      await fill();
      fireEvent.click(screen.getByLabelText(vi_['iss.create.geo.consent.label']));
      set(vi_['iss.create.geo.lat.label'], '91');
      set(vi_['iss.create.geo.lng.label'], '106.7');
      submit();
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.invalidLatitude.error']);
      expect(h.command).not.toHaveBeenCalled();
      set(vi_['iss.create.geo.lat.label'], '10.8');
      set(vi_['iss.create.geo.accuracy.label'], '12');
      submit();
      await screen.findByTestId('created');
      expect(sentBody(h)).toMatchObject({ geo_consent: true, geo_lat: '10.8', geo_lng: '106.7', geo_accuracy_m: '12' });
    });

    it('fills the position from the device when the person asks, and says when the device cannot give it', async () => {
      const getCurrentPosition = vi.fn((success: (position: unknown) => void) => success({ coords: { latitude: 10.8123456, longitude: 106.7123456, accuracy: 12.345 } }));
      vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
      open();
      await ready();
      fireEvent.click(screen.getByLabelText(vi_['iss.create.geo.consent.label']));
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.create.geo.locate.action'] }));
      await waitFor(() => expect((screen.getByLabelText(vi_['iss.create.geo.lat.label']) as HTMLInputElement).value).toBe('10.812346'));
      expect((screen.getByLabelText(vi_['iss.create.geo.lng.label']) as HTMLInputElement).value).toBe('106.712346');
      expect((screen.getByLabelText(vi_['iss.create.geo.accuracy.label']) as HTMLInputElement).value).toBe('12.35');
      getCurrentPosition.mockImplementation((_success: unknown, failure?: () => void) => failure?.());
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.create.geo.locate.action'] }));
      expect((await screen.findByTestId('locate-failed')).textContent).toBe(vi_['iss.create.geo.unavailable.notice']);
      cleanup();
      vi.stubGlobal('navigator', {});
      open();
      await ready();
      fireEvent.click(screen.getByLabelText(vi_['iss.create.geo.consent.label']));
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.create.geo.locate.action'] }));
      expect(await screen.findByTestId('locate-failed')).toBeTruthy();
    });
  });

  it('is shown but not usable to those who may not report an issue, or while the system is read-only', async () => {
    open(reporting(), READER);
    await ready();
    expect(screen.getByText(vi_['iss.create.denied.notice'])).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['iss.create.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mountIssue(<IssueCreateScreen route={ROUTE} />, reporting(), { permissions: REPORTER, mode: 'READ_ONLY', path: '/iss/iss-02' });
    expect(await screen.findByText(vi_['iss.create.frozen.notice'])).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['iss.create.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });
});
