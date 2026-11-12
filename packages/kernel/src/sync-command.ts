import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';

/**
 * The commands a phone queues offline (ST-MOB-005, MOB 4, 6, 7). Each carries the key it was given on the phone (a local UUID, at least 16 characters) and is carried out by the operation of the platform that
 * it stands for, exactly as if it had been sent online: the same permission, scope, license, period and version rules decide it. The rules below are pure.
 */
export const SYNC_COMMAND_TYPES = ['report.submit', 'report.draft.save', 'issue.create', 'site_diary.append', 'measurement.record', 'inspection.result', 'pwf.task.start', 'pwf.task.checklist.complete', 'pwf.task.evidence.attach', 'pwf.task.complete', 'pwf.task.exception.request'] as const;
export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];
export const MAX_BATCH_ITEMS = 50;
export const MIN_KEY_LENGTH = 16;
export const MAX_KEY_LENGTH = 128;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A checklist item code goes into a path: only the characters of a code, never a separator. */
const ITEM_CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The request that stands for a queued command: a POST to one operation, at the version the phone saw when it is a change to a record that has one. */
export interface InvocationPlan {
  path: string;
  body: Record<string, unknown>;
  /** The command changes a record that has a version: the request goes with `If-Match` set to the version the phone based it on. */
  versioned: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Takes the id out of the payload: it names the record in the path, and only a UUID goes into a path. */
function split(payload: Record<string, unknown>, field: string): { id: string; rest: Record<string, unknown> } {
  const id = payload[field];
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid(field);
  const rest: Record<string, unknown> = { ...payload };
  delete rest[field];
  return { id: id.toLowerCase(), rest };
}

/**
 * The operation a queued command stands for. A command of a type the platform does not carry, or one whose payload does not name the record it is about, is 422 `VALIDATION_FAILED` (never forwarded).
 * `site_diary.append` saves a new draft of the day, or a revision of a draft when the payload names it (`diary_id`).
 */
export function planOf(commandType: string, payload: unknown, baseServerVersion = 0): InvocationPlan {
  if (!isRecord(payload)) throw invalid('payload');
  switch (commandType) {
    case 'report.submit': {
      const { id } = split(payload, 'report_id');
      return { path: `/reports/${id}/submit`, body: {}, versioned: true };
    }
    case 'report.draft.save': {
      const { id, rest } = split(payload, 'report_id');
      return { path: `/reports/${id}/revisions`, body: rest, versioned: true };
    }
    case 'issue.create':
      return { path: '/issues', body: payload, versioned: false };
    case 'site_diary.append': {
      // The diary of the day is saved over the version the phone read: the operation takes it in its body.
      if (payload.diary_id === undefined) return { path: '/site-diaries', body: { ...payload, base_server_version: baseServerVersion }, versioned: false };
      const { id, rest } = split(payload, 'diary_id');
      return { path: `/site-diaries/${id}/draft`, body: rest, versioned: true };
    }
    case 'measurement.record': {
      const { id, rest } = split(payload, 'contract_id');
      return { path: `/contracts/${id}/measurements`, body: rest, versioned: false };
    }
    case 'inspection.result': {
      // The result of an inspection is recorded over the version of the inspection the phone read (`If-Match`).
      const { id, rest } = split(payload, 'inspection_id');
      return { path: `/inspections/${id}/result`, body: rest, versioned: true };
    }
    // The work on a task of the workflow of a project (PWF, MOB-79). A task is changed over the version the phone read (`If-Match`); evidence and a request for an exception do not change the version. An approval, a return and a signing
    // are never queued: they are decisions of another person and are made online.
    case 'pwf.task.start': {
      const { id, rest } = split(payload, 'task_id');
      return { path: `/project-tasks/${id}/start`, body: rest, versioned: true };
    }
    case 'pwf.task.checklist.complete': {
      const { id, rest } = split(payload, 'task_id');
      const item = rest.item_code;
      if (typeof item !== 'string' || !ITEM_CODE.test(item)) throw invalid('item_code');
      delete rest.item_code;
      return { path: `/project-tasks/${id}/checklist/${item}/complete`, body: rest, versioned: true };
    }
    case 'pwf.task.evidence.attach': {
      const { id, rest } = split(payload, 'task_id');
      return { path: `/project-tasks/${id}/evidence`, body: rest, versioned: false };
    }
    case 'pwf.task.complete': {
      const { id, rest } = split(payload, 'task_id');
      return { path: `/project-tasks/${id}/complete`, body: rest, versioned: true };
    }
    case 'pwf.task.exception.request': {
      const { id, rest } = split(payload, 'task_id');
      return { path: `/project-tasks/${id}/exceptions`, body: rest, versioned: false };
    }
    default:
      throw invalid('command_type');
  }
}

export interface QueuedCommand {
  command_type: string;
  base_server_version: number;
  payload: unknown;
}

/** What makes a command the same command: the same key with another type, version or payload is a different command, and is refused, not carried out. */
export const syncRequestHashOf = (item: QueuedCommand): string => sha256Hex(canonicalJson({ command_type: item.command_type, base_server_version: item.base_server_version, payload: item.payload }));

export type ItemOutcome =
  | { kind: 'accepted'; serverVersion: number | undefined; resultRef: string | undefined }
  | { kind: 'conflict'; code: string; serverVersion: number | undefined }
  | { kind: 'rejected'; code: string }
  /** The operation could not be reached or failed in a way that may go away (a 5xx, a rate limit, a lapsed session): nothing is remembered and the phone sends the command again. */
  | { kind: 'transient'; code: string };

/** The refusals that say the phone based its command on a version that is no longer the record: the record's own, and the site diary's (it keeps the copy of the phone beside the diary of the day). */
const CONFLICT_CODES: ReadonlySet<string> = new Set(['VERSION_CONFLICT', 'DRAFT_VERSION_CONFLICT', 'DIARY_SYNC_CONFLICT']);
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;

/**
 * What the operation answered, in the words of the sync endpoint (MOB 4): done; a conflict the person has to look at (never settled by last write wins); refused for good, with the code of the platform; or not settled yet.
 */
export function outcomeOf(status: number, body: unknown): ItemOutcome {
  const answer = isRecord(body) ? body : {};
  const rawCode = typeof answer.code === 'string' && CODE.test(answer.code) ? answer.code : undefined;
  const numeric = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
  if (status >= 200 && status < 300) {
    return { kind: 'accepted', serverVersion: numeric(answer.resource_version) ?? numeric(answer.version), resultRef: typeof answer.resource_id === 'string' ? answer.resource_id : undefined };
  }
  if (status === 409 && rawCode !== undefined && CONFLICT_CODES.has(rawCode)) return { kind: 'conflict', code: rawCode, serverVersion: numeric(answer.current_version) ?? numeric(answer.server_version) };
  if (status === 401) return { kind: 'transient', code: 'SESSION_EXPIRED' };
  // The same command is still being carried out by another request: its answer is not in yet, so nothing is settled by this one.
  if (status === 409 && rawCode === 'IDEMPOTENCY_IN_PROGRESS') return { kind: 'transient', code: rawCode };
  if (status === 408 || status === 429 || status >= 500 || status === 0) return { kind: 'transient', code: rawCode ?? 'UNAVAILABLE' };
  return { kind: 'rejected', code: rawCode ?? 'COMMAND_REFUSED' };
}
