import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { readBytes, sha256Hex } from '../../ctr/boq-model';
import { contractId, line as contractLine, mount } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { diary } from '../diary/test-support';
import { routeOf } from '../inspection/test-support';
import PhotoCaptureScreen from './PhotoCaptureScreen';

export type { Harness };

export const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
export const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
export const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

export const lost = () => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} });

export const ROUTE = routeOf('QMS-10', 'FR-QMS-10');
/** The site engineer: registers photos, reads photos, contracts and diaries. */
export const ENGINEER = ['photo.upload', 'photo.read', 'contract.read', 'site_diary.read'];
export const PHOTO = '00000000-0000-4000-8000-00f000000001';
export const CONTRACT = contractId(2);
export const KEY = 'tenants/t1/site_photo/abc';

/** The bytes of the test photo and what the screen should make of them. */
export const BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
export const fileOf = (name = 'cau.jpg', type = 'image/jpeg', bytes: Uint8Array<ArrayBuffer> = BYTES): File => new File([bytes], name, { type });
export const hashOf = async (bytes: Uint8Array<ArrayBuffer> = BYTES): Promise<string> => sha256Hex(await readBytes(new Blob([bytes])));

export interface Served {
  /** The photos the register already holds, in the shape of the list. */
  known?: Array<Record<string, unknown>>;
  /** The checks of the photo that is registered, or the error to fail with. */
  checks?: Record<string, unknown> | Error;
  failing?: Set<string>;
}

export function open(
  served: Served = {},
  options: {
    permissions?: readonly string[] | undefined;
    mode?: 'FULL' | 'READ_ONLY';
    command?: (operation: string, input: unknown) => unknown;
    contracts?: Array<Record<string, unknown>> | Error;
    pending?: boolean;
  } = {},
): Harness {
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const h = baseHarness(
    (operation) => {
      if (served.failing?.has(operation) === true) return new Error(`${operation} failed`);
      if (operation === 'get_resources_site_photo') return { items: served.known ?? [], as_of: '2026-10-25T04:00:00.000Z' };
      if (operation === 'getSitePhotoChecks') return served.checks ?? new Error('no checks');
      if (operation === 'get_resources_site_diary') return { items: [diary(1)], as_of: '2026-10-25T04:00:00.000Z' };
      return new Error(`unexpected read ${operation}`);
    },
    options.command ?? ((operation) => (operation === 'registerSitePhoto' ? { resource_id: PHOTO } : {})),
  );
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation !== 'get_resources_contract') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    if (options.pending === true) return new Promise(() => undefined);
    return respond(options.contracts ?? [contractLine(1), contractLine(2, { status: 'ACTIVE', title: null })]);
  });
  mount(<PhotoCaptureScreen route={ROUTE} />, h, {
    permissions: 'permissions' in options ? options.permissions : ENGINEER,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    path: '/qms/qms-10',
  });
  return h;
}

export const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** Chooses the photo of the test and waits for its hash. */
export async function choosePhoto(file: File = fileOf()): Promise<void> {
  await screen.findByRole('option', { name: /^HD-A-002$/ });
  fireEvent.change(screen.getByLabelText(word('qms.capture.field.file')), { target: { files: [file] } });
}

/** Fills the form of a photo for the contract of the test, with the file chosen. */
export async function fillPhoto(): Promise<void> {
  await choosePhoto();
  await screen.findByTestId('file-facts');
  type(word('qms.capture.field.contract'), CONTRACT);
  type(word('qms.capture.field.key'), KEY);
}

export const register = (): void => {
  fireEvent.click(screen.getByRole('button', { name: word('qms.capture.submit.action') }));
};

/** The bodies of the commands sent. */
export const sent = (h: Harness): Array<Record<string, unknown>> =>
  h.command.mock.calls.filter(([name]) => name === 'registerSitePhoto').map(([, input]) => (input as { body: Record<string, unknown> }).body);

/** A photo as the register lists it, for the repetition check. */
export const known = (sha: string) => ({
  id: PHOTO,
  project: { id: '00000000-0000-4000-8000-000000000001', code: 'PRJ-A-001' },
  contract: { id: CONTRACT, code: 'HD-A-002' },
  file_sha256: sha,
  received_at: '2026-10-25T03:00:00.000Z',
  checks: { time: 'OK', geofence: 'INSIDE', duplicate: 'UNIQUE', exif: 'CONSISTENT', summary: 'PASS' },
  flags: [],
  geo_consent: false,
  place: null,
  uploaded_by: { display_name: 'Bình' },
});
