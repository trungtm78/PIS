import type { components } from '@machvon/contracts';
import { shaped } from '../shared/format';

/** ORG-01: the organisation and the roles of the enterprise edition (ENT-3d). The pack is read-only here; the load goes through the batch import of ADM and the command that follows it. */
export type OrgPack = components['schemas']['EntOrgPack'];
export type Materialisation = components['schemas']['EntOrgPackMaterialisation'];
export type Seat = OrgPack['seats'][number];
export type PlanItem = OrgPack['plan'][number];

export const PLAN_ACTIONS = ['CREATE', 'UNCHANGED', 'PENDING', 'DRIFT', 'BLOCKED'] as const;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of a translation key that names a value: `INPUT_POINT` is `inputPoint`. */
export const camel = (word: string): string => word.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const toPack = (raw: unknown): OrgPack =>
  shaped<OrgPack>(raw, 'organisation pack', ['units', 'roles', 'seats', 'steps', 'catalogue', 'plan', 'defects'], ['loader', 'delegation', 'doa', 'counts', 'seat_counts']);
export const toMaterialisation = (raw: unknown): Materialisation => shaped<Materialisation>(raw, 'organisation pack load', ['items'], ['counts', 'seat_counts']);

/** The tone of a plan action: what stands is calm, what waits is a watch, what differs or is blocked is a warning. */
export function toneOf(action: string): 'success' | 'neutral' | 'warning' | 'danger' {
  if (action === 'UNCHANGED' || action === 'CREATED') return 'success';
  if (action === 'DRIFT' || action === 'BLOCKED') return 'danger';
  if (action === 'PENDING') return 'warning';
  return 'neutral';
}

/** The unit rows in tree order (parents first, children by code), so that the table reads as the organisation. */
export function unitsInOrder(units: OrgPack['units']): OrgPack['units'] {
  const rank = (unit: OrgPack['units'][number]): number => (unit.parent_code === null ? 0 : 1);
  return [...units].sort((a, b) => rank(a) - rank(b));
}

/** The file of the template as a download: the bytes the server holds, with the byte-order mark the file starts with. */
export function csvBlob(csv: string): Blob {
  return new Blob([csv], { type: 'text/csv;charset=utf-8' });
}
