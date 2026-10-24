import { DomainError } from '@machvon/kernel';
import type { NotificationPriority } from '@machvon/db';

/** Who a notification goes to (NOT 3.1 step 2); only the two kinds the core needs. */
export type ResolverDefinition =
  | { kind: 'explicit' }
  | { kind: 'role-in-scope'; roles: readonly string[] };

/** One channel of the plan of a workflow: the inbox, or an external channel with the code of the template its messages are written from. */
export interface ChannelEntry {
  channel: string;
  templateCode?: string;
}

/** The part of `workflow_version.definition_json` the core reads. */
export interface NotificationDefinition {
  /** The channels in the order they are tried (NOT 3.1 step 4). The inbox is always first for CRITICAL and HIGH, and default for the others. */
  channels: ChannelEntry[];
  resolver: ResolverDefinition;
  priority: NotificationPriority;
  ackRequired: boolean;
  expiresAfterMinutes: number;
  purpose: string;
}

const PRIORITIES: readonly string[] = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];
const CHANNELS: readonly string[] = ['IN_APP', 'EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP'];
const MAX_CHANNELS = 6;
const TEMPLATE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DEFAULT_EXPIRY_MINUTES = 7 * 24 * 60;
const MAX_EXPIRY_MINUTES = 365 * 24 * 60;

function invalid(field: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, `workflow.definition.${field}`);
}

function resolverOf(value: unknown): ResolverDefinition {
  if (value === undefined) return { kind: 'explicit' };
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (record === undefined) throw invalid('resolver');
  if (record.kind === 'explicit') return { kind: 'explicit' };
  if (record.kind === 'role-in-scope') {
    const roles = record.roles;
    if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== 'string' || role === '')) throw invalid('resolver.roles');
    return { kind: 'role-in-scope', roles: roles as string[] };
  }
  throw invalid('resolver.kind');
}

function channelsOf(value: unknown, priority: string): ChannelEntry[] {
  const entries: ChannelEntry[] = [];
  if (value !== undefined) {
    if (!Array.isArray(value) || value.length > MAX_CHANNELS) throw invalid('channels');
    for (const item of value as unknown[]) {
      const record = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
      const channel = record?.channel;
      if (typeof channel !== 'string' || !CHANNELS.includes(channel) || entries.some((entry) => entry.channel === channel)) throw invalid('channels.channel');
      if (channel === 'IN_APP') {
        entries.push({ channel });
        continue;
      }
      // An external channel writes its messages from a template: without one there is nothing to send.
      if (typeof record?.templateCode !== 'string' || !TEMPLATE_CODE.test(record.templateCode)) throw invalid('channels.templateCode');
      entries.push({ channel, templateCode: record.templateCode });
    }
  }
  const inbox = entries.filter((entry) => entry.channel === 'IN_APP');
  const others = entries.filter((entry) => entry.channel !== 'IN_APP');
  // The inbox is the one channel that needs no consent and no provider: it is always there for urgent messages and by default for the others.
  return inbox.length > 0 || priority === 'CRITICAL' || priority === 'HIGH' || others.length === 0 ? [{ channel: 'IN_APP' }, ...others] : others;
}

/** Reads the workflow definition with defaults (NORMAL, no acknowledgement, 7 days, OPERATIONAL); a bad value is a configuration error. */
export function definitionOf(raw: unknown): NotificationDefinition {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const priority = record.priority ?? 'NORMAL';
  if (typeof priority !== 'string' || !PRIORITIES.includes(priority)) throw invalid('priority');
  const ackRequired = record.ackRequired ?? false;
  if (typeof ackRequired !== 'boolean') throw invalid('ackRequired');
  const expiry = record.expiresAfterMinutes ?? DEFAULT_EXPIRY_MINUTES;
  if (typeof expiry !== 'number' || !Number.isInteger(expiry) || expiry < 1 || expiry > MAX_EXPIRY_MINUTES) throw invalid('expiresAfterMinutes');
  const purpose = record.purpose ?? 'OPERATIONAL';
  if (typeof purpose !== 'string' || purpose === '') throw invalid('purpose');
  return { channels: channelsOf(record.channels, priority), resolver: resolverOf(record.resolver), priority: priority as NotificationPriority, ackRequired, expiresAfterMinutes: expiry, purpose };
}
