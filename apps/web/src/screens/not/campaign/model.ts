import { ApiError } from '@machvon/api-client';

/** Permissions of the screens (x-permission in openapi.json). */
export const READ_PERMISSION = 'notification.campaign.read';
export const MANAGE_PERMISSION = 'notification.campaign.manage';
export const APPROVE_PERMISSION = 'notification.campaign.approve';

export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const NAME_MAX = 120;
/** How long a notification of a campaign may still be sent after its time (the server's working assumption: 7 days). */
export const VALIDITY_DAYS = 7;

export const STATUSES = ['Draft', 'Previewed', 'PendingApproval', 'Approved', 'Scheduled', 'Sending', 'Completed', 'Rejected', 'Cancelled'] as const;
export type CampaignStatus = (typeof STATUSES)[number];
export const PURPOSES = ['ANNOUNCEMENT', 'REMINDER', 'OPERATIONAL'] as const;
export type CampaignPurpose = (typeof PURPOSES)[number];
export const EXCLUSIONS = ['opted_out', 'no_consent', 'inactive', 'duplicate'] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];
export type Exclusions = Record<Exclusion, number>;

/** The states a campaign can still be cancelled in. */
export const CANCELLABLE: readonly CampaignStatus[] = ['Draft', 'Previewed', 'PendingApproval', 'Approved', 'Scheduled', 'Sending'];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

export interface Campaign {
  id: string;
  name: string;
  purpose: CampaignPurpose;
  templateVersionId: string;
  templateCode: string;
  templateChannel: string;
  unitIds: string[];
  /** The units of the segment with their names, as the server resolves them. */
  units: Array<{ id: string; name: string; code: string }>;
  roleCodes: string[];
  includeGuests: boolean;
  scheduledAt: string | undefined;
  status: CampaignStatus;
  recipientCount: number | undefined;
  excluded: Exclusions | undefined;
  previewHash: string | undefined;
  previewedAt: string | undefined;
  createdBy: string;
  createdAt: string;
  submittedAt: string | undefined;
  approvedBy: string | undefined;
  approvedAt: string | undefined;
  decisionReason: string | undefined;
  notificationCount: number;
  waitingCount: number;
  version: number;
}

export interface CampaignPage {
  items: Campaign[];
  nextCursor: string | undefined;
}

export function toExclusions(raw: unknown): Exclusions | undefined {
  if (!isRecord(raw)) return undefined;
  return { opted_out: count(raw.opted_out), no_consent: count(raw.no_consent), inactive: count(raw.inactive), duplicate: count(raw.duplicate) };
}

export function toCampaign(raw: unknown): Campaign | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return undefined;
  const segment = isRecord(raw.segment) ? raw.segment : {};
  const status = STATUSES.find((candidate) => candidate === raw.status);
  const purpose = PURPOSES.find((candidate) => candidate === raw.purpose);
  if (status === undefined || purpose === undefined) return undefined;
  return {
    id: raw.id,
    name: raw.name,
    purpose,
    templateVersionId: text(raw.template_version_id),
    templateCode: text(raw.template_code),
    templateChannel: text(raw.template_channel),
    unitIds: strings(segment.unit_ids),
    units: Array.isArray(segment.units) ? segment.units.filter(isRecord).map((unit) => ({ id: text(unit.id), name: text(unit.name), code: text(unit.code) })) : [],
    roleCodes: strings(segment.role_codes),
    includeGuests: segment.include_guests === true,
    scheduledAt: optional(raw.scheduled_at),
    status,
    recipientCount: typeof raw.recipient_count === 'number' ? raw.recipient_count : undefined,
    excluded: toExclusions(raw.excluded),
    previewHash: optional(raw.preview_hash),
    previewedAt: optional(raw.previewed_at),
    createdBy: text(raw.created_by),
    createdAt: text(raw.created_at),
    submittedAt: optional(raw.submitted_at),
    approvedBy: optional(raw.approved_by),
    approvedAt: optional(raw.approved_at),
    decisionReason: optional(raw.decision_reason),
    notificationCount: count(raw.notification_count),
    waitingCount: count(raw.waiting_count),
    version: count(raw.version),
  };
}

export function toCampaignPage(raw: unknown): CampaignPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toCampaign(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

export interface Preview {
  recipientCount: number;
  excluded: Exclusions;
  hash: string;
  samples: string[];
  previewedAt: string;
  version: number;
}

export function toPreview(raw: unknown): Preview {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    recipientCount: count(view.recipient_count),
    excluded: toExclusions(view.excluded) ?? { opted_out: 0, no_consent: 0, inactive: 0, duplicate: 0 },
    hash: text(view.preview_hash),
    samples: strings(view.sample_recipients_masked),
    previewedAt: text(view.previewed_at),
    version: count(view.version),
  };
}

export const excludedTotal = (excluded: Exclusions | undefined): number => (excluded === undefined ? 0 : EXCLUSIONS.reduce((sum, reason) => sum + excluded[reason], 0));

/**
 * The last instant a notification of the campaign may still be sent: the validity after the moment the sends were due. That is its time, or the approval when it has no time or was approved after it (the server counts from
 * the later of the two); before the approval, an estimate from its time.
 */
export function validUntil(campaign: Pick<Campaign, 'scheduledAt' | 'approvedAt'>): Date | undefined {
  const instants = [campaign.scheduledAt, campaign.approvedAt].flatMap((value) => (value === undefined ? [] : [new Date(value).getTime()])).filter((value) => !Number.isNaN(value));
  if (instants.length === 0) return undefined;
  return new Date(Math.max(...instants) + VALIDITY_DAYS * 86_400_000);
}

/** The first characters of the hash, enough to compare two screens. */
export const shortHash = (hash: string | undefined): string => (hash === undefined ? '' : hash.slice(0, 12));

// ---- the form of a campaign -----------------------------------------------------------------------------------------------------------

export interface CampaignForm {
  name: string;
  purpose: CampaignPurpose;
  templateId: string;
  unitIds: string[];
  roles: string;
  includeGuests: boolean;
  /** The value of a `datetime-local` field: the local time, or empty for "as soon as it is approved". */
  scheduledAt: string;
}

export const emptyForm = (): CampaignForm => ({ name: '', purpose: 'ANNOUNCEMENT', templateId: '', unitIds: [], roles: '', includeGuests: false, scheduledAt: '' });

const ROLE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const parseRoles = (value: string): string[] => [...new Set(value.split(/[\s,;]+/).map((item) => item.trim().toUpperCase()).filter((item) => item !== ''))].sort();

export type CampaignProblem = 'name' | 'template' | 'segment' | 'roles' | 'schedule';

/** What the server would refuse, judged the way it does, so the person is told before sending. */
export function campaignProblems(form: CampaignForm, now: Date): CampaignProblem[] {
  const found: CampaignProblem[] = [];
  const name = form.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) found.push('name');
  if (form.templateId === '') found.push('template');
  const roles = parseRoles(form.roles);
  if (roles.some((code) => !ROLE_CODE.test(code)) || roles.length > 20) found.push('roles');
  else if (form.unitIds.length === 0 && roles.length === 0) found.push('segment');
  if (form.scheduledAt !== '') {
    const at = new Date(form.scheduledAt);
    const lead = at.getTime() - now.getTime();
    if (Number.isNaN(at.getTime()) || lead < 60_000 || lead > 366 * 86_400_000) found.push('schedule');
  }
  return found;
}

export function campaignBody(form: CampaignForm): Record<string, unknown> {
  const roles = parseRoles(form.roles);
  return {
    name: form.name.trim(),
    purpose: form.purpose,
    template_version_id: form.templateId,
    segment: { ...(form.unitIds.length === 0 ? {} : { unit_ids: form.unitIds }), ...(roles.length === 0 ? {} : { role_codes: roles }), include_guests: form.includeGuests },
    ...(form.scheduledAt === '' ? {} : { scheduled_at: new Date(form.scheduledAt).toISOString() }),
  };
}

export const reasonProblem = (reason: string): boolean => reason.trim().length < REASON_MIN || reason.trim().length > REASON_MAX;

// ---- what the server refused with -----------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'segment' | 'template' | 'stale' | 'self' | 'state' | 'channel' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SEGMENT_INVALID: 'segment',
  TEMPLATE_INVALID: 'template',
  PREVIEW_STALE: 'stale',
  SELF_APPROVAL_DENIED: 'self',
  CAMPAIGN_STATE_INVALID: 'state',
  CHANNEL_UNVERIFIED: 'channel',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
