import { ApiError } from '@machvon/api-client';

/** The permission of NOT-05 and NOT-06 (x-permission of the operations in openapi.json): who writes and publishes the notification workflows of the tenant. */
export const PUBLISH_PERMISSION = 'notification.publish';

export const PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** The channels in the order a new workflow tries them: the inbox first, then the ones that need a template. */
export const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS'] as const;
export type Channel = (typeof CHANNELS)[number];
export const MIN_EXPIRY_MINUTES = 1;
export const MAX_EXPIRY_MINUTES = 365 * 24 * 60;
export const DEFAULT_EXPIRY_MINUTES = 7 * 24 * 60;
export const MIN_OVERRIDE_REASON = 10;
export const MAX_OVERRIDE_REASON = 500;
export const MIN_PUBLISH_REASON = 10;
export const MAX_PUBLISH_REASON = 2000;
/** The same rule as the server's `TEMPLATE_CODE`. */
const TEMPLATE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';
export type WorkflowStatus = 'Draft' | 'Published' | 'Superseded' | 'Retired';

export interface EventTypeView {
  eventType: string;
  owningModule: string;
  schemaVersion: number;
  allowedPurposes: string[];
  classification: Classification;
  active: boolean;
}

export interface ChannelStep {
  channel: string;
  templateCode: string | undefined;
}

/** The part of the definition of a workflow the screen shows. */
export interface DefinitionView {
  priority: string;
  purpose: string;
  ackRequired: boolean;
  expiresAfterMinutes: number;
  channels: ChannelStep[];
  resolver: string;
  roles: string[];
  quietHoursOverride: boolean;
  overrideReason: string | undefined;
}

export interface WorkflowView {
  id: string;
  eventType: string;
  revision: number;
  status: WorkflowStatus;
  definition: DefinitionView;
  createdBy: string;
  publishedBy: string | undefined;
  publishedAt: string | undefined;
  createdAt: string;
  version: number;
}

export interface WorkflowPage {
  items: WorkflowView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const CLASSIFICATIONS: readonly string[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL'];
const STATUSES: readonly string[] = ['Draft', 'Published', 'Superseded', 'Retired'];

export function toEventType(raw: unknown): EventTypeView | undefined {
  if (!isRecord(raw) || typeof raw.event_type !== 'string') return undefined;
  return {
    eventType: raw.event_type,
    owningModule: text(raw.owning_module),
    schemaVersion: typeof raw.schema_version === 'number' ? raw.schema_version : 1,
    allowedPurposes: Array.isArray(raw.allowed_purposes) ? raw.allowed_purposes.filter((item): item is string => typeof item === 'string') : [],
    classification: CLASSIFICATIONS.includes(text(raw.data_classification)) ? (raw.data_classification as Classification) : 'PERSONAL',
    active: raw.status === 'Active',
  };
}

export const toEventTypes = (raw: unknown): EventTypeView[] => (isRecord(raw) && Array.isArray(raw.items) ? raw.items.flatMap((item) => toEventType(item) ?? []) : []);

/**
 * The plan as the core runs it (`channelsOf` in apps/api/src/notifications/definition.ts): the inbox, when it is there, goes first, and an urgent message (CRITICAL, HIGH) always has it; a plan with no channel is the inbox
 * alone. The editor and the list show this plan, so what is shown is what is executed.
 */
export function runtimeChannels<T extends { channel: string }>(steps: readonly T[], priority: string, inbox: T): T[] {
  const inApp = steps.filter((step) => step.channel === 'IN_APP');
  const others = steps.filter((step) => step.channel !== 'IN_APP');
  return inApp.length > 0 || priority === 'CRITICAL' || priority === 'HIGH' || others.length === 0 ? [inApp[0] ?? inbox, ...others] : others;
}

function definitionOf(raw: unknown): DefinitionView {
  const record = isRecord(raw) ? raw : {};
  const channels = Array.isArray(record.channels)
    ? record.channels.flatMap((item): ChannelStep[] => (isRecord(item) && typeof item.channel === 'string' ? [{ channel: item.channel, templateCode: optional(item.templateCode) }] : []))
    : [];
  const resolver = isRecord(record.resolver) && typeof record.resolver.kind === 'string' ? record.resolver.kind : 'explicit';
  const roles = isRecord(record.resolver) && Array.isArray(record.resolver.roles) ? record.resolver.roles.filter((role): role is string => typeof role === 'string') : [];
  const priority = typeof record.priority === 'string' ? record.priority : 'NORMAL';
  return {
    priority,
    purpose: typeof record.purpose === 'string' ? record.purpose : 'OPERATIONAL',
    ackRequired: record.ackRequired === true,
    // The core's default when the draft says nothing (definitionOf): what the approver authorizes is what runs.
    expiresAfterMinutes: typeof record.expiresAfterMinutes === 'number' ? record.expiresAfterMinutes : DEFAULT_EXPIRY_MINUTES,
    channels: runtimeChannels(channels, priority, { channel: 'IN_APP', templateCode: undefined }),
    resolver,
    roles,
    quietHoursOverride: record.quietHoursOverride === true,
    overrideReason: optional(record.quietHoursOverrideReason),
  };
}

export function toWorkflow(raw: unknown): WorkflowView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.event_type !== 'string') return undefined;
  return {
    id: raw.id,
    eventType: raw.event_type,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    status: STATUSES.includes(text(raw.status)) ? (raw.status as WorkflowStatus) : 'Draft',
    definition: definitionOf(raw.definition),
    createdBy: text(raw.created_by),
    publishedBy: optional(raw.published_by),
    publishedAt: optional(raw.published_at),
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export function toWorkflowPage(raw: unknown): WorkflowPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toWorkflow(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

/** What the designer form holds. */
export interface ChannelRow {
  channel: Channel;
  enabled: boolean;
  templateCode: string;
}

export interface DesignerForm {
  purpose: string;
  priority: Priority;
  ackRequired: boolean;
  expiresAfterMinutes: string;
  resolverKind: 'explicit' | 'role-in-scope';
  roles: string;
  channels: ChannelRow[];
  quietHoursOverride: boolean;
  overrideReason: string;
}

export const emptyForm = (purpose: string): DesignerForm => ({
  purpose,
  priority: 'NORMAL',
  ackRequired: false,
  expiresAfterMinutes: String(DEFAULT_EXPIRY_MINUTES),
  resolverKind: 'explicit',
  roles: '',
  channels: CHANNELS.map((channel) => ({ channel, enabled: channel === 'IN_APP', templateCode: '' })),
  quietHoursOverride: false,
  overrideReason: '',
});

export type FormField = 'purpose' | 'expiry' | 'roles' | 'channels' | 'templates' | 'override';

const rolesOf = (value: string): string[] => value.split(',').map((role) => role.trim()).filter((role) => role !== '');

/** The fields of the form the server would refuse, judged the way it does (the server stays the judge). */
export function invalidFields(form: DesignerForm, allowedPurposes: readonly string[]): ReadonlySet<FormField> {
  const bad = new Set<FormField>();
  if (!allowedPurposes.includes(form.purpose)) bad.add('purpose');
  const expiry = Number(form.expiresAfterMinutes);
  if (form.expiresAfterMinutes.trim() === '' || !Number.isInteger(expiry) || expiry < MIN_EXPIRY_MINUTES || expiry > MAX_EXPIRY_MINUTES) bad.add('expiry');
  if (form.resolverKind === 'role-in-scope' && rolesOf(form.roles).length === 0) bad.add('roles');
  const enabled = form.channels.filter((row) => row.enabled || (row.channel === 'IN_APP' && inboxIsForced(form.priority)));
  if (enabled.length === 0) bad.add('channels');
  if (enabled.some((row) => row.channel !== 'IN_APP' && !TEMPLATE_CODE.test(row.templateCode.trim()))) bad.add('templates');
  if (form.quietHoursOverride && (form.priority !== 'CRITICAL' || form.overrideReason.trim().length < MIN_OVERRIDE_REASON || form.overrideReason.trim().length > MAX_OVERRIDE_REASON)) bad.add('override');
  return bad;
}

/** The definition the server reads (`definitionOf` in apps/api/src/notifications/definition.ts), from the form. */
export function definitionFromForm(form: DesignerForm): Record<string, unknown> {
  return {
    priority: form.priority,
    purpose: form.purpose,
    ackRequired: form.ackRequired,
    expiresAfterMinutes: Number(form.expiresAfterMinutes),
    channels: runtimeChannels(
      form.channels.filter((row) => row.enabled || (row.channel === 'IN_APP' && inboxIsForced(form.priority))),
      form.priority,
      { channel: 'IN_APP' as Channel, enabled: true, templateCode: '' },
    ).map((row) => (row.channel === 'IN_APP' ? { channel: row.channel } : { channel: row.channel, templateCode: row.templateCode.trim() })),
    resolver: form.resolverKind === 'explicit' ? { kind: 'explicit' } : { kind: 'role-in-scope', roles: rolesOf(form.roles) },
    quietHoursOverride: form.quietHoursOverride,
    ...(form.quietHoursOverride ? { quietHoursOverrideReason: form.overrideReason.trim() } : {}),
  };
}

/** Whether the inbox is part of the plan whatever the editor says: an urgent message always has it. */
export const inboxIsForced = (priority: Priority): boolean => priority === 'CRITICAL' || priority === 'HIGH';

/** Moves a channel one place earlier or later in the order they are tried. The inbox stays first (the core puts it there), so no channel goes above it and it does not move. */
export function moveChannel(rows: readonly ChannelRow[], index: number, by: -1 | 1): ChannelRow[] {
  const target = index + by;
  if (rows[index]?.channel === 'IN_APP' || target < 1 || target >= rows.length) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as ChannelRow);
  return next;
}

export const isPublishReasonValid = (reason: string): boolean => reason.trim().length >= MIN_PUBLISH_REASON && reason.trim().length <= MAX_PUBLISH_REASON;
export const canPublish = (workflow: Pick<WorkflowView, 'status'>): boolean => workflow.status === 'Draft';

export type ProblemReason = 'eventType' | 'definition' | 'self' | 'conflict' | 'notDraft' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  EVENT_TYPE_UNKNOWN: 'eventType',
  WORKFLOW_DEFINITION_INVALID: 'definition',
  SELF_APPROVAL_DENIED: 'self',
  VERSION_CONFLICT: 'conflict',
  WORKFLOW_NOT_DRAFT: 'notDraft',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
