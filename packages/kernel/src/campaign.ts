import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The broadcast campaign (ST-NOT-009, NOT 3.5, BR-NOT-12): a campaign is made as a draft, previewed (who would get it and who would not, with a hash of the set), sent to approval with that hash, and approved by someone else;
 * a campaign whose set of recipients changed since the preview is refused (PREVIEW_STALE) and must be previewed again. The rules below are pure.
 */
export const CAMPAIGN_PURPOSES = ['ANNOUNCEMENT', 'REMINDER', 'OPERATIONAL'] as const;
export type CampaignPurpose = (typeof CAMPAIGN_PURPOSES)[number];

export type CampaignStatus = 'Draft' | 'Previewed' | 'PendingApproval' | 'Approved' | 'Scheduled' | 'Sending' | 'Completed' | 'Rejected' | 'Cancelled';

/** The event type the notifications of a campaign carry: its category in the preferences of a person is `campaign`. */
export const CAMPAIGN_EVENT_TYPE = 'campaign.broadcast';
/**
 * The most recipients a campaign may have [assumption: the notifications of a campaign are made in the transaction of the decision, so the size is bounded; a larger one is split into campaigns until a batch launch exists].
 */
export const MAX_CAMPAIGN_RECIPIENTS = 5_000;
/** How long after its time a campaign notification may still be sent; after that it expires and is not sent [assumption: 7 days, the spec only says an expired message is not sent]. */
export const CAMPAIGN_VALIDITY_MS = 7 * 86_400_000;

const MAX_NAME = 120;
const MAX_UNITS = 100;
const MAX_ROLES = 20;
const ROLE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 366 * 86_400_000;
const MIN_REASON = 10;
const MAX_REASON = 2000;
const MAX_EVIDENCE = 20;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface CampaignSegment {
  unitIds: string[];
  roleCodes: string[];
  includeGuests: boolean;
}

export interface CampaignDraft {
  name: string;
  purpose: CampaignPurpose;
  templateVersionId: string;
  segment: CampaignSegment;
  scheduledAt: Date | undefined;
}

function uniqueUuids(value: unknown, field: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid(field);
  const ids = value.map((entry) => asUuid(entry));
  if (ids.some((entry) => entry === undefined)) throw invalid(field);
  return [...new Set(ids as string[])].sort();
}

/** What a new campaign may carry: a name, one of the purposes, the template, a segment that names someone (units, roles, or both) and a time in the future, or no time (as soon as it is approved). */
export function assertCampaignDraft(raw: { name?: unknown; purpose?: unknown; template_version_id?: unknown; segment?: unknown; scheduled_at?: unknown }, now: Date): CampaignDraft {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME) throw invalid('name');
  const purpose = CAMPAIGN_PURPOSES.find((candidate) => candidate === raw.purpose);
  if (purpose === undefined) throw invalid('purpose');
  const templateVersionId = asUuid(raw.template_version_id);
  if (templateVersionId === undefined) throw invalid('template_version_id');
  const segment = raw.segment;
  if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) throw invalid('segment');
  const parts = segment as { unit_ids?: unknown; role_codes?: unknown; include_guests?: unknown };
  const unitIds = uniqueUuids(parts.unit_ids, 'segment.unit_ids', MAX_UNITS);
  let roleCodes: string[] = [];
  if (parts.role_codes !== undefined) {
    if (!Array.isArray(parts.role_codes) || parts.role_codes.length > MAX_ROLES || parts.role_codes.some((code) => typeof code !== 'string' || !ROLE_CODE.test(code))) throw invalid('segment.role_codes');
    roleCodes = [...new Set(parts.role_codes as string[])].sort();
  }
  if (parts.include_guests !== undefined && typeof parts.include_guests !== 'boolean') throw invalid('segment.include_guests');
  // A segment that names nobody is not a segment: refusing it here keeps "everybody" from being the result of an empty form.
  if (unitIds.length === 0 && roleCodes.length === 0) throw new DomainError('SEGMENT_INVALID', 409, 'segment');
  let scheduledAt: Date | undefined;
  if (raw.scheduled_at !== undefined) {
    scheduledAt = typeof raw.scheduled_at === 'string' ? new Date(raw.scheduled_at) : undefined;
    if (scheduledAt === undefined || Number.isNaN(scheduledAt.getTime())) throw invalid('scheduled_at');
    const lead = scheduledAt.getTime() - now.getTime();
    if (lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) throw invalid('scheduled_at');
  }
  return { name, purpose, templateVersionId, segment: { unitIds, roleCodes, includeGuests: parts.include_guests === true }, scheduledAt };
}

/** The set of recipients the way it is fingerprinted (NOT 3.5): the recipient ids in order, the template, and the time; the same set under the same template at the same time gives the same hash. */
export function previewHashOf(input: { recipientIds: readonly string[]; templateVersionId: string; scheduledAt: Date | undefined }): string {
  const ids = [...input.recipientIds].map((id) => id.toLowerCase()).sort();
  return createHash('sha256')
    .update(`${ids.join(',')}|${input.templateVersionId.toLowerCase()}|${input.scheduledAt?.toISOString() ?? ''}`, 'utf8')
    .digest('hex');
}

export const EXCLUSION_REASONS = ['opted_out', 'no_consent', 'inactive', 'duplicate'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export type Exclusions = Record<ExclusionReason, number>;

export const emptyExclusions = (): Exclusions => ({ opted_out: 0, no_consent: 0, inactive: 0, duplicate: 0 });

/** What is known about a person the segment reaches, for the channel and the purpose of the campaign. */
export interface CandidateFacts {
  /** The membership is Active now (a suspended, expired or ended membership is not written to). */
  active: boolean;
  /** The first membership of the person among those the segment reaches: the person is written to once. */
  firstOfPerson: boolean;
  /** The person has not turned the channel off for the campaigns (NOT-03). */
  channelEnabled: boolean;
  /** The person's consent covers the channel and the purpose where the table of BR-NOT-07 asks for one. */
  consented: boolean;
}

/** Why a person is not written to, or undefined when they are; each person is counted under one reason, the first that applies: inactive, duplicate, opted out, no consent. */
export function exclusionOf(facts: CandidateFacts): ExclusionReason | undefined {
  if (!facts.active) return 'inactive';
  if (!facts.firstOfPerson) return 'duplicate';
  if (!facts.channelEnabled) return 'opted_out';
  if (!facts.consented) return 'no_consent';
  return undefined;
}

const TRANSITIONS: Readonly<Record<string, Readonly<Partial<Record<string, CampaignStatus>>>>> = {
  preview: { Draft: 'Previewed', Previewed: 'Previewed' },
  submit: { Previewed: 'PendingApproval' },
  approve: { PendingApproval: 'Approved' },
  return: { PendingApproval: 'Draft' },
  reject: { PendingApproval: 'Rejected' },
  schedule: { Approved: 'Scheduled' },
  start: { Approved: 'Sending', Scheduled: 'Sending' },
  complete: { Sending: 'Completed' },
  cancel: { Draft: 'Cancelled', Previewed: 'Cancelled', PendingApproval: 'Cancelled', Approved: 'Cancelled', Scheduled: 'Cancelled', Sending: 'Cancelled' },
};
export type CampaignAction = 'preview' | 'submit' | 'approve' | 'return' | 'reject' | 'schedule' | 'start' | 'complete' | 'cancel';

/** The state a campaign is in after an action, or a 409 `CAMPAIGN_STATE_INVALID` when the action does not apply to the state it is in. */
export function campaignAfter(status: CampaignStatus, action: CampaignAction): CampaignStatus {
  const next = TRANSITIONS[action]?.[status];
  if (next === undefined) throw new DomainError('CAMPAIGN_STATE_INVALID', 409, 'status');
  return next;
}

export interface CampaignSubmission {
  previewHash: string;
  reason: string | undefined;
}

export function assertCampaignSubmission(raw: { preview_hash?: unknown; reason?: unknown }): CampaignSubmission {
  if (typeof raw.preview_hash !== 'string' || !HASH.test(raw.preview_hash)) throw invalid('preview_hash');
  let reason: string | undefined;
  if (raw.reason !== undefined) {
    reason = typeof raw.reason === 'string' ? raw.reason.trim() : undefined;
    if (reason === undefined || reason.length < MIN_REASON || reason.length > MAX_REASON) throw invalid('reason');
  }
  return { previewHash: raw.preview_hash, reason };
}

export type CampaignVerdict = 'approve' | 'return' | 'reject';

export interface CampaignVerdictInput {
  decision: CampaignVerdict;
  reason: string;
  evidenceIds: string[];
}

export function assertCampaignVerdict(raw: { decision?: unknown; reason?: unknown; evidence_ids?: unknown }): CampaignVerdictInput {
  const decision = (['approve', 'return', 'reject'] as const).find((candidate) => candidate === raw.decision);
  if (decision === undefined) throw invalid('decision');
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 1 || reason.length > MAX_REASON) throw invalid('reason');
  return { decision, reason, evidenceIds: uniqueUuids(raw.evidence_ids, 'evidence_ids', MAX_EVIDENCE) };
}

/** A reason for the preview and the cancellation (the body is only a reason): 10 to 2000 characters. */
export function assertCampaignReason(raw: { reason?: unknown }): string {
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw invalid('reason');
  return reason;
}

export { MAX_EVIDENCE as MAX_CAMPAIGN_EVIDENCE };
