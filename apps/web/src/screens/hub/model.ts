import type { components } from '@machvon/contracts';
import { ApiError } from '@machvon/api-client';
import type { Tone } from '../../ui';

export type Schemas = components['schemas'];
export type Summary = Schemas['HubConnectorSummary'];
export type ConnectorList = Schemas['HubConnectorList'];
export type HubSummary = Schemas['HubSummary'];
export type Detail = Schemas['HubConnectorDetail'];
export type Run = Schemas['HubRun'];
export type Incident = Schemas['HubIncident'];
export type Mapping = Schemas['HubMapping'];
export type Reject = Schemas['HubReject'];
export type Agent = Schemas['HubAgent'];
export type Kpi = Schemas['HubKpi'];
export type Health = Schemas['HubHealthSummary'];
export type Pipeline = Schemas['HubPipelineView'];
export type Status = Summary['status'];

export const REASON_MIN = 10;
export const STATUSES: readonly Status[] = ['HEALTHY', 'STALE', 'FAILING', 'DISABLED', 'PENDING_EXTERNAL', 'NEVER_RUN'];
export const DETAIL_TABS = ['overview', 'runs', 'pipeline', 'mapping', 'differences', 'credentials', 'layouts'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** The tab an arrow key, Home or End moves to in the WAI-ARIA tabs pattern (the arrows wrap round at the ends); undefined for any other key. */
export function tabAfterKey(current: DetailTab, key: string): DetailTab | undefined {
  const last = DETAIL_TABS.length - 1;
  const at = DETAIL_TABS.indexOf(current);
  switch (key) {
    case 'ArrowRight':
      return DETAIL_TABS[at === last ? 0 : at + 1];
    case 'ArrowLeft':
      return DETAIL_TABS[at === 0 ? last : at - 1];
    case 'Home':
      return DETAIL_TABS[0];
    case 'End':
      return DETAIL_TABS[last];
    default:
      return undefined;
  }
}

/** The word of a code in the keys of the screens: `PENDING_EXTERNAL` is `pendingExternal`. */
export const word = (code: string): string => code.toLowerCase().replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());

export const statusTone = (status: Status): Tone => {
  switch (status) {
    case 'HEALTHY':
      return 'success';
    case 'STALE':
      return 'warning';
    case 'FAILING':
      return 'danger';
    case 'PENDING_EXTERNAL':
      return 'info';
    default:
      return 'neutral';
  }
};

export const outcomeTone = (outcome: Run['outcome']): Tone => (outcome === 'SUCCEEDED' ? 'success' : outcome === 'PARTIAL' ? 'warning' : outcome === 'FAILED' ? 'danger' : 'neutral');
export const incidentTone = (state: Incident['state']): Tone => (state === 'RESOLVED' ? 'success' : state === 'ACKNOWLEDGED' ? 'info' : 'danger');
export const agentTone = (health: Agent['health']): Tone => (health === 'ONLINE' ? 'success' : health === 'STALE' ? 'warning' : 'neutral');
export const severityTone = (severity: Incident['severity']): Tone => (severity === 'URGENT' ? 'danger' : severity === 'ACTION' ? 'warning' : 'info');

/** The age of the data as a number and a unit word ("hours" under two days, else "days"); null when nothing succeeded yet. */
export function ageParts(hours: number | null): { value: string; unit: 'hours' | 'days' } | null {
  if (hours === null) return null;
  if (hours < 48) return { value: String(Math.round(hours * 10) / 10), unit: 'hours' };
  return { value: String(Math.round((hours / 24) * 10) / 10), unit: 'days' };
}

export function vietnamDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || Number.isNaN(Date.parse(iso))) return '–';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

export interface Refusal {
  code: string;
  status: number;
  detail: string | undefined;
  rejectCode: string | undefined;
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError) {
    const rejectCode = error.extensions.reject_code;
    return { code: error.code, status: error.status, detail: error.detail, rejectCode: typeof rejectCode === 'string' ? rejectCode : undefined };
  }
  return { code: 'UNKNOWN', status: 0, detail: undefined, rejectCode: undefined };
}

export const needsReason = (error: unknown): boolean => {
  const refusal = refusalOf(error);
  return refusal.code === 'VALIDATION_FAILED' && (refusal.detail === 'reason' || refusal.detail === 'resolution');
};

/** Whether the reason typed is long enough for the command (the same ten characters the server asks for). */
export const reasonOk = (text: string): boolean => text.trim().length >= REASON_MIN;

/** The share of figures that count for the headline: monitored connectors as "n of m", or a dash when nothing is monitored (no figure beats a false one). */
export const healthyLabel = (summary: HubSummary): { value: string; of: string } =>
  summary.healthy_percent === null ? { value: '–', of: `0/${summary.total}` } : { value: String(summary.healthy_percent), of: `${summary.healthy}/${summary.monitored}` };

/** The fields of a mapping typed as JSON by a person: an array of objects, at least one; anything else is refused before the request. */
export function parseMappingFields(text: string): Array<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item)) ? (parsed as Array<Record<string, unknown>>) : undefined;
  } catch {
    return undefined;
  }
}

export const MAPPING_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The runs of one pipeline stage counts as "in, out, rejected" for the pipeline tab. */
export function stageLine(run: Run | null): string | null {
  return run === null ? null : `${run.rows_total} / ${run.rows_applied} / ${run.rows_rejected}`;
}
