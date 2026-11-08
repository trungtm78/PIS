import { ApiError } from '@machvon/api-client';
import { harness, mount } from '../../sas/test-support';
import type { WebRoute } from '../../../routes/types';
import vi from '../../../i18n/parts/gov12-docaud.vi.json';
import base from '../../../i18n/vi.json';

export { harness, mount };

/** The membership of the session of the harness (`PLATFORM_TENANT`). */
export const ME = '00000000-0000-4000-8000-0000000000e9';
export const AS_OF = '2027-03-10T03:00:00.000Z';
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const sha = (letter: string): string => letter.repeat(64);
export const never = (): Promise<never> => new Promise<never>(() => undefined);

export const routeOf = (id: string, module: string, req: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'table', area: 'insights', module, group: 'GOV-12', role: 'workspace', parent: null, req });

export const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

/** The words of the screens, read from the part that the lane adds (and from the base catalogue for the shared states). */
export const word = (key: string): string => {
  const found = (vi as Record<string, string | undefined>)[key] ?? (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
export const fill = (key: string, params: Record<string, string | number>): string => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));

/** A pattern that matches the text literally (the words hold brackets). */
export const rx = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
