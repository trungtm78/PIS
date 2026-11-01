import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURES } from '../../prj/closeout/test-support';
import { slowDevice } from '../../qms/offline/locate-support';
import { RECORDER, REPORTER, answer, category, choose, fill, lost, open, problem, recorded, scheduled, sent, unit, word } from './test-support';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ready = () => screen.findByTestId('facts');
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${word('iss.field.submit.record')}|${word('iss.field.submit.raise')}`) }));
};
const label = (key: string): string => word(key);
const chooseOptions = async (): Promise<void> => {
  await screen.findByRole('option', { name: /UBND-1/ });
  await screen.findByRole('option', { name: /GPMB-1/ });
  choose(label('iss.field.unit.label'), unit(1).id);
  choose(label('iss.field.category.label'), category(1).version_id as string);
};
/** Fills a result with two failed items and one that passed. */
const failTwo = (): void => {
  answer('DOC', 'FAIL', 'Thiếu chứng chỉ');
  answer('SAMPLE', 'PASS');
  answer('SAFE', 'FAIL');
  choose(label('iss.field.result.label'), 'FAIL');
  fireEvent.change(screen.getByLabelText(label('iss.field.resultNote.label')), { target: { value: 'Hai hạng mục không đạt' } });
};

describe('SiteInspectionScreen (ISS-05): a field inspection against its checklist', () => {
  it('UI-ISS-05: shows the location, the time and the inspectors of the inspection and its checklist', async () => {
    open([scheduled(1)]);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(label('iss.field.page.title'));
    expect(screen.getByTestId('location').textContent).toBe('Km 12+300, đường vào cầu');
    expect(screen.getByTestId('time').textContent).toContain('30/10/26');
    expect(screen.getByTestId('inspectors').textContent).toBe('Giám sát Bình');
    expect(document.querySelectorAll('[data-item]')).toHaveLength(3);
    expect(screen.getByTestId('no-failed').textContent).toBe(label('iss.field.noFailed.notice'));
  });

  it('shows the fallback words for an inspection with no location, time or inspector', async () => {
    open([scheduled(1, { location_text: null, scheduled_at: null, participants: [] })]);
    await ready();
    for (const id of ['location', 'time', 'inspectors']) expect(screen.getByTestId(id).textContent).toBe(label('iss.field.fact.none'));
  });

  it('AC-ST-ISS-007-1: records the result, then raises one issue per failed item with the source and no position without consent', async () => {
    const h = open([scheduled(1)]);
    await ready();
    failTwo();
    await chooseOptions();
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(2));
    const recordedBody = sent(h, 'recordInspectionResult')[0];
    expect(recordedBody).toEqual({
      result: 'FAIL',
      result_note: 'Hai hạng mục không đạt',
      checklist: [
        { code: 'DOC', outcome: 'FAIL', note: 'Thiếu chứng chỉ' },
        { code: 'SAMPLE', outcome: 'PASS' },
        { code: 'SAFE', outcome: 'FAIL' },
      ],
    });
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 1, path: { id: scheduled(1).id } });
    const [first, second] = sent(h, 'createIssue');
    expect(first).toMatchObject({
      source_module: 'QMS',
      title: 'KT-001 · Hồ sơ vật liệu đầy đủ',
      description: 'Thiếu chứng chỉ',
      owner_unit_id: unit(1).id,
      category_version_id: category(1).version_id,
      severity: 'MEDIUM',
    });
    expect(second).toMatchObject({ source_module: 'QMS', title: 'KT-001 · Biện pháp an toàn tại vị trí', description: 'Biện pháp an toàn tại vị trí' });
    expect(first?.source_ref_id).not.toBe(second?.source_ref_id);
    expect(first?.contract_id).toBe((scheduled(1).contract as { id: string }).id);
    for (const body of [first, second]) {
      expect(body).not.toHaveProperty('geo_consent');
      expect(body).not.toHaveProperty('geo_lat');
      expect(body).not.toHaveProperty('geo_lng');
    }
    await waitFor(() => expect(screen.getByTestId('raised-count').textContent).toContain(fill(label('iss.field.raised.notice'), { done: 2, total: 2 })));
    const rows = within(screen.getByTestId('raise-items')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['raised', 'raised']);
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: label('iss.field.item.open') })
        .getAttribute('href'),
    ).toBe('/iss/iss-03?id=00000000-0000-4000-8000-00000000a0a0');
  });

  it('keeps the position with the issues only with the consent, takes it away with the consent, and sends it when the person consented', async () => {
    const h = open([scheduled(1)]);
    await ready();
    failTwo();
    await chooseOptions();
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    fireEvent.change(screen.getByLabelText(label('iss.field.geo.lat.label')), { target: { value: '10.8' } });
    fireEvent.change(screen.getByLabelText(label('iss.field.geo.lng.label')), { target: { value: '106.7' } });
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    expect((screen.getByLabelText(label('iss.field.geo.lat.label')) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(label('iss.field.geo.lat.label')) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    fireEvent.change(screen.getByLabelText(label('iss.field.geo.lat.label')), { target: { value: '10.8' } });
    fireEvent.change(screen.getByLabelText(label('iss.field.geo.lng.label')), { target: { value: '106.7' } });
    fireEvent.change(screen.getByLabelText(label('iss.field.geo.accuracy.label')), { target: { value: '12' } });
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(2));
    for (const body of sent(h, 'createIssue')) expect(body).toMatchObject({ geo_consent: true, geo_lat: '10.8', geo_lng: '106.7', geo_accuracy_m: '12' });
  });

  it('refuses a position typed and then left without consent in the form, and sends nothing', async () => {
    const h = open([scheduled(1)]);
    await ready();
    failTwo();
    await chooseOptions();
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(2));
    for (const body of sent(h, 'createIssue')) expect(body).not.toHaveProperty('geo_consent');
  });

  it('fills the position from the device only after the consent, and says when the device cannot give it', async () => {
    const getCurrentPosition = vi.fn((success: (position: unknown) => void) => success({ coords: { latitude: 10.8123456, longitude: 106.7123456, accuracy: 12.345 } }));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    open([scheduled(1)]);
    await ready();
    failTwo();
    const locate = screen.getByRole('button', { name: label('iss.field.geo.locate.action') }) as HTMLButtonElement;
    expect(locate.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    fireEvent.click(locate);
    await waitFor(() => expect((screen.getByLabelText(label('iss.field.geo.lat.label')) as HTMLInputElement).value).toBe('10.812346'));
    expect((screen.getByLabelText(label('iss.field.geo.accuracy.label')) as HTMLInputElement).value).toBe('12.35');
    getCurrentPosition.mockImplementation((_success: unknown, failure?: () => void) => failure?.());
    fireEvent.click(locate);
    expect((await screen.findByTestId('locate-failed')).textContent).toBe(label('iss.field.geo.unavailable.notice'));
    vi.stubGlobal('navigator', {});
    fireEvent.click(locate);
    expect(screen.getByTestId('locate-failed')).toBeTruthy();
  });

  it('drops a position that arrives after the consent was taken back, and sends no position', async () => {
    const device = slowDevice();
    const h = open([scheduled(1)]);
    await ready();
    failTwo();
    await chooseOptions();
    const consent = screen.getByLabelText(label('iss.field.geo.consent.label')) as HTMLInputElement;
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: label('iss.field.geo.locate.action') }));
    fireEvent.click(consent);
    device.arrive();
    expect(consent.checked).toBe(false);
    expect((screen.getByLabelText(label('iss.field.geo.lat.label')) as HTMLInputElement).value).toBe('');
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(2));
    for (const body of sent(h, 'createIssue')) for (const key of ['geo_consent', 'geo_lat', 'geo_lng', 'geo_accuracy_m']) expect(body).not.toHaveProperty(key);
  });

  it('the failure of a request in flight when the consent was taken back does not show, and a new request still fills the position', async () => {
    const device = slowDevice();
    open([scheduled(1)]);
    await ready();
    failTwo();
    const consent = screen.getByLabelText(label('iss.field.geo.consent.label'));
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: label('iss.field.geo.locate.action') }));
    fireEvent.click(consent);
    fireEvent.click(consent);
    device.fail();
    expect(screen.queryByTestId('locate-failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label('iss.field.geo.locate.action') }));
    device.arrive();
    expect((screen.getByLabelText(label('iss.field.geo.lat.label')) as HTMLInputElement).value).toBe('10.812346');
  });

  it('puts a position that arrives while the consent holds into the form and keeps what was chosen meanwhile', async () => {
    const device = slowDevice();
    const h = open([scheduled(1)]);
    await ready();
    failTwo();
    fireEvent.click(screen.getByLabelText(label('iss.field.geo.consent.label')));
    fireEvent.click(screen.getByRole('button', { name: label('iss.field.geo.locate.action') }));
    await chooseOptions();
    device.arrive();
    expect((screen.getByLabelText(label('iss.field.geo.lat.label')) as HTMLInputElement).value).toBe('10.812346');
    expect((screen.getByLabelText(label('iss.field.unit.label')) as HTMLSelectElement).value).toBe(unit(1).id);
    expect((screen.getByLabelText(label('iss.field.category.label')) as HTMLSelectElement).value).toBe(category(1).version_id);
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(2));
    for (const body of sent(h, 'createIssue')) expect(body).toMatchObject({ geo_consent: true, geo_lat: '10.812346', geo_lng: '106.712346', geo_accuracy_m: '12.35' });
  });

  it('stops raising issues when the screen is left while the first is in flight, and sends nothing more', async () => {
    let answer: () => void = () => undefined;
    const h = open([scheduled(1)], {
      command: (operation) => (operation === 'createIssue' ? new Promise((resolve) => (answer = () => resolve({ resource_id: '00000000-0000-4000-8000-00000000a0a0' }))) : {}),
    });
    await ready();
    failTwo();
    await chooseOptions();
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(1));
    cleanup();
    await act(async () => answer());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent(h, 'createIssue')).toHaveLength(1);
  });

  it('names what is missing and sends nothing: the answers, the result, the unit, the category and a position without consent', async () => {
    const h = open([scheduled(1)]);
    await ready();
    submit();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(h.command).not.toHaveBeenCalled();
    failTwo();
    submit();
    expect(screen.getByLabelText(label('iss.field.unit.label')).getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
    choose(label('iss.field.result.label'), 'PASS');
    await chooseOptions();
    submit();
    expect(screen.getByTestId('contradiction')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the refusal of the recording and raises nothing', async () => {
    const h = open([scheduled(1)]);
    h.command.mockImplementation((operation: string) => (operation === 'recordInspectionResult' ? Promise.reject(problem(409, 'VERSION_CONFLICT')) : Promise.resolve({})));
    await ready();
    failTwo();
    await chooseOptions();
    submit();
    expect((await screen.findByTestId('record-problem')).textContent).toBe(word('qms.inspection.error.versionConflict'));
    expect(sent(h, 'createIssue')).toEqual([]);
  });

  it('says which issues exist and which could not be raised, and finishes the rest from the recorded inspection', async () => {
    const h = open([scheduled(1)]);
    h.command.mockImplementation((operation: string, input: unknown) => {
      if (operation === 'createIssue') {
        const body = (input as { body: { title: string } }).body;
        return body.title.includes('Hồ sơ') ? Promise.reject(problem(409, 'DUPLICATE_SOURCE_OPEN')) : Promise.reject(lost());
      }
      return Promise.resolve({});
    });
    await ready();
    failTwo();
    await chooseOptions();
    submit();
    await waitFor(() => expect(screen.getAllByRole('listitem').some((row) => row.getAttribute('data-state') === 'failed')).toBe(true));
    const rows = within(screen.getByTestId('raise-items')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['existing', 'failed']);
    expect(rows[0]?.textContent).toContain(label('iss.field.item.existing'));
    expect(within(rows[1] as HTMLElement).getByRole('alert').textContent).toBe(word('iss.issueProblem.general.error'));
    expect(screen.getByTestId('raised-count').textContent).toContain(fill(label('iss.field.raised.notice'), { done: 1, total: 2 }));
    // The lost answer keeps the operation of the item, so that sending again is the same issue.
    h.command.mockImplementation(() => Promise.resolve({ resource_id: '00000000-0000-4000-8000-00000000a0a1' }));
    submit();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('raise-items'))
          .getAllByRole('listitem')
          .map((row) => row.getAttribute('data-state')),
      ).toEqual(['existing', 'raised']),
    );
    const failedTries = sent(h, 'createIssue').filter((body) => String(body.title).includes('Biện pháp'));
    expect(failedTries).toHaveLength(2);
    expect(failedTries[0]?.client_operation_id).toBe(failedTries[1]?.client_operation_id);
    expect(failedTries[0]?.source_ref_id).toBe(failedTries[1]?.source_ref_id);
    expect(screen.getByRole('link', { name: label('iss.field.raised.list') }).getAttribute('href')).toBe('/iss/iss-01');
  });

  it('offers the issues of a recorded inspection that failed, raised from what the server recorded', async () => {
    const h = open([recorded(1, ['FAIL', 'PASS', 'FAIL'])]);
    await ready();
    expect(screen.getByTestId('recorded').textContent).toBe(label('iss.field.recorded.notice'));
    expect(document.querySelectorAll('[data-item] select')).toHaveLength(0);
    await chooseOptions();
    submit();
    await waitFor(() => expect(sent(h, 'createIssue')).toHaveLength(2));
    expect(sent(h, 'recordInspectionResult')).toEqual([]);
    expect(sent(h, 'createIssue')[0]).toMatchObject({ description: 'Thiếu chứng chỉ' });
    await waitFor(() => expect((screen.getByRole('button', { name: label('iss.field.submit.raise') }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('lists only the inspections the screen can work on and moves between them', async () => {
    open([scheduled(1), recorded(2, ['PASS', 'PASS', 'PASS']), recorded(3, ['FAIL', 'NA', 'NA'], { inspection_no: 'KT-003', title: 'Đợt ba' })]);
    await ready();
    const options = within(screen.getByLabelText(label('iss.field.inspection.label'))).getAllByRole('option');
    expect(options).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(label('iss.field.inspection.label')), { target: { value: recorded(3, ['FAIL', 'NA', 'NA']).id as string } });
    expect((await screen.findByTestId('recorded')).textContent).toBe(label('iss.field.recorded.notice'));
  });

  it('opens the inspection named in the address', async () => {
    open([scheduled(1), scheduled(2, { inspection_no: 'KT-002' })], { path: `/iss/iss-05?id=${scheduled(2).id as string}` });
    await ready();
    expect((screen.getByLabelText(label('iss.field.inspection.label')) as HTMLSelectElement).value).toBe(scheduled(2).id);
  });

  it('records without raising when the caller may not create issues, and raises without recording when the result is in', async () => {
    const h = open([scheduled(1)], { permissions: RECORDER });
    await ready();
    answer('DOC', 'FAIL', 'x');
    answer('SAMPLE', 'PASS');
    answer('SAFE', 'PASS');
    choose(label('iss.field.result.label'), 'FAIL');
    fireEvent.change(screen.getByLabelText(label('iss.field.resultNote.label')), { target: { value: 'Một hạng mục' } });
    expect(screen.getByTestId('cannot-raise').textContent).toBe(label('iss.field.raiseDenied.notice'));
    submit();
    await waitFor(() => expect(sent(h, 'recordInspectionResult')).toHaveLength(1));
    expect(sent(h, 'createIssue')).toEqual([]);
  });

  it('does not ask for the unit and the category when the caller may only report on a recorded inspection, and cannot record a scheduled one', async () => {
    const h = open([recorded(1, ['FAIL', 'PASS', 'PASS']), scheduled(2)], { permissions: REPORTER });
    await ready();
    expect(screen.getByTestId('raise-panel')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(label('iss.field.inspection.label')), { target: { value: scheduled(2).id as string } });
    expect((await screen.findByTestId('cannot-record')).textContent).toBe(label('iss.field.denied.notice'));
    expect((screen.getByRole('button', { name: label('iss.field.submit.raise') }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('is read-only for a suspended tenant: nothing is recorded and nothing is raised', async () => {
    const h = open([recorded(1, ['FAIL', 'PASS', 'PASS'])], { mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('cannot-raise').textContent).toBe(label('iss.field.frozen.notice'));
    submit();
    expect(h.command).not.toHaveBeenCalled();
    cleanup();
    open([scheduled(1)], { mode: 'READ_ONLY' });
    expect((await screen.findByTestId('cannot-record')).textContent).toBe(label('iss.field.frozen.notice'));
  });

  it('shows the denied state and reads nothing without the permission to read inspections', async () => {
    const h = open([scheduled(1)], { permissions: ['issue.create'] });
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the empty state when no inspection is waiting and reads while the permissions are not known', async () => {
    open([scheduled(1, { actions: { schedule: false, record: false, cancel: false } })], { permissions: undefined });
    expect((await screen.findByText(word('states.empty.title'))).tagName).toBe('H1');
  });

  it('shows the loading state while the inspections are on their way', () => {
    open([scheduled(1)], { pending: true });
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it.each(FAILURES)('shows the %s state when the read fails, and reads again on retry', async (_name, failure, title) => {
    const h = open([scheduled(1)], { failing: failure });
    expect((await screen.findByText(title)).tagName).toBe('H1');
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(1));
  });
});
