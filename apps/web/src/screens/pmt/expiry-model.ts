import { permitLink } from './dossier-model';

/** The windows the board offers, in days: the first alert is at 60 days, and a year is as far as the server reads. */
export const WINDOWS: readonly number[] = [15, 30, 60, 90, 180, 365];
export const DEFAULT_WINDOW = 60;

export type ExpiringStatus = 'ISSUED' | 'EXPIRED';

export interface ExpiringPermitView {
  id: string;
  dossierId: string;
  permitTypeCode: string | null;
  permitTypeName: string;
  permitNo: string | null;
  status: ExpiringStatus;
  validUntil: string;
  /** Days to the last day by the Vietnam date of the read; negative once it has passed. */
  daysLeft: number;
  /** 0 to 4: the level of alert the permit has reached (60, 30, 15 and 0 days); an expired one is at the last. */
  alertLevel: number;
  /** The days of the threshold the level stands for (60, 30, 15 or 0), or null when no alert is due yet. */
  thresholdDays: number | null;
  project: { id: string; code: string; name: string };
  responsible: { membershipId: string; displayName: string } | null;
}

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

/** A permit of the board as `listExpiringPermits` answers it; undefined when it is not the shape of one. */
export function toExpiringPermit(raw: unknown): ExpiringPermitView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const dossierId = text(row?.dossier_id);
  const status = text(row?.status);
  const validUntil = text(row?.valid_until);
  const daysLeft = whole(row?.days_left);
  const alertLevel = whole(row?.alert_level);
  const project = asRecord(row?.project);
  const projectId = text(project?.id);
  if (row === undefined || id === undefined || dossierId === undefined || validUntil === undefined || daysLeft === undefined || alertLevel === undefined || projectId === undefined) return undefined;
  if (status !== 'ISSUED' && status !== 'EXPIRED') return undefined;
  if (alertLevel < 0 || alertLevel > 4) return undefined;
  const responsible = asRecord(row.responsible);
  const membershipId = text(responsible?.membership_id);
  return {
    id,
    dossierId,
    permitTypeCode: text(row.permit_type_code) ?? null,
    permitTypeName: text(row.permit_type_name) ?? '',
    permitNo: text(row.permit_no) ?? null,
    status,
    validUntil,
    daysLeft,
    alertLevel,
    thresholdDays: whole(row.alert_threshold_days) ?? null,
    project: { id: projectId, code: text(project?.code) ?? '', name: text(project?.name) ?? '' },
    responsible: membershipId === undefined ? null : { membershipId, displayName: text(responsible?.display_name) ?? '' },
  };
}

export type UrgencyKind = 'EXPIRED' | 'LAST_DAY' | 'SOON' | 'AHEAD';

/** How urgent a permit is: past its day, on its last day, within the last 15 days, or further away. */
export function urgencyOf(permit: Pick<ExpiringPermitView, 'status' | 'daysLeft'>): UrgencyKind {
  if (permit.status === 'EXPIRED' || permit.daysLeft < 0) return 'EXPIRED';
  if (permit.daysLeft === 0) return 'LAST_DAY';
  return permit.daysLeft <= 15 ? 'SOON' : 'AHEAD';
}

export interface BoardSummary {
  /** Issued permits still in force that end within the window. */
  expiring: number;
  /** Permits past their last day that no renewal has replaced. */
  expired: number;
}

export function summaryOf(permits: readonly ExpiringPermitView[]): BoardSummary {
  const expired = permits.filter((permit) => urgencyOf(permit) === 'EXPIRED').length;
  return { expiring: permits.length - expired, expired };
}

/** The window an address names, when it is one the board offers. */
export function windowOf(value: string | null): number {
  const days = value !== null && /^\d{1,3}$/.test(value) ? Number(value) : undefined;
  return days !== undefined && WINDOWS.includes(days) ? days : DEFAULT_WINDOW;
}

/** Where the person goes to see a permit and renew it: the permit's own screen. */
export const renewLink = permitLink;
