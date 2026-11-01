import { lateDays } from '../recommendation/model';
import type { BoardItem } from '../recommendation/model';

/** AUD-09 and AUD-11: the evidence of the remediation and the recommendations that are near their day or past it (ST-AUD-006, AUD 3.3, BR-AUD-06). */
export const READ_PERMISSION = 'aud.read';
export const BOARD_PATH = '/aud/aud-07';

/** The days before the due day on which the daily job reminds the owner. */
export const REMINDER_DAYS = [7, 3, 1] as const;
/** The days late from which the escalation goes on to the second level: an assumption that waits for the policy of the tenant. */
export const SECOND_LEVEL_DAYS = 15;

/** Whether the permission is held; a session that does not list its permissions leaves the decision to the server. */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

export interface EvidenceRow {
  key: string;
  recommendationId: string;
  recommendationCode: string;
  engagementCode: string;
  actionCode: string;
  note: string;
  documentId: string;
  doneOn: string | null;
}

/**
 * The evidence a recommendation stands on: the documents that closed its actions. The server accepts only a document in force (or a file that was scanned clean) as the proof of an action that is done, so an action that is
 * not done and an action without a document have nothing to list.
 */
export function evidenceRows(items: readonly BoardItem[]): EvidenceRow[] {
  return items.flatMap((item) =>
    item.actions.flatMap((action) =>
      action.status === 'DONE' && action.evidenceDocumentId !== null
        ? [
            {
              key: action.id,
              recommendationId: item.id,
              recommendationCode: item.code,
              engagementCode: item.engagement.code,
              actionCode: action.code,
              note: action.description,
              documentId: action.evidenceDocumentId,
              doneOn: action.completedOn,
            },
          ]
        : [],
    ),
  );
}

export const LEVELS = ['dueSoon', 'leader', 'second'] as const;
export type Level = (typeof LEVELS)[number];

export interface EscalationRow {
  item: BoardItem;
  level: Level;
  /** The days past the due day; none before it. */
  lateDays: number;
  /** The days to the due day; none once it has passed. */
  daysLeft: number;
  /** The reminders (7, 3 and 1 days before the day) the due day has already come to. */
  reminders: number[];
}

const DAY = 24 * 60 * 60 * 1000;
const WATCHED_AGAINST_DUE = new Set(['ASSIGNED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);

const daysTo = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/**
 * Where a recommendation stands against its day: a reminder is due in the last seven days, once the day has passed the unit leader of the owner is told, and from the day the second level begins the escalation goes on. A
 * recommendation that is closed, cancelled, disputed or not yet given to anyone is not watched.
 */
export function escalationOf(item: BoardItem, today: string): EscalationRow | undefined {
  if (item.dueOn === null || !WATCHED_AGAINST_DUE.has(item.status)) return undefined;
  const late = lateDays(item, today);
  if (late > 0) return { item, level: late >= SECOND_LEVEL_DAYS ? 'second' : 'leader', lateDays: late, daysLeft: 0, reminders: [...REMINDER_DAYS] };
  const daysLeft = daysTo(today, item.dueOn);
  const first = REMINDER_DAYS[0];
  if (daysLeft > first) return undefined;
  return { item, level: 'dueSoon', lateDays: 0, daysLeft, reminders: REMINDER_DAYS.filter((day) => daysLeft <= day) };
}

/** The recommendations to watch, the latest first and then the nearest day. */
export function escalations(items: readonly BoardItem[], today: string): EscalationRow[] {
  return items
    .flatMap((item) => escalationOf(item, today) ?? [])
    .sort((left, right) => right.lateDays - left.lateDays || left.daysLeft - right.daysLeft || left.item.code.localeCompare(right.item.code));
}

/** How many recommendations stand at each level. */
export function levelCounts(rows: readonly EscalationRow[]): Record<Level, number> {
  const counts: Record<Level, number> = { dueSoon: 0, leader: 0, second: 0 };
  for (const row of rows) counts[row.level] += 1;
  return counts;
}
