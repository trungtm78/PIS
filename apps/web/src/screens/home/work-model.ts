type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export const WORK_KINDS = ['APPROVAL', 'EXPLANATION', 'REPORT_RETURNED', 'REPORT_DRAFT_OVERDUE', 'EXPLANATION_REVIEW', 'MNE_OBLIGATION'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const BUCKETS = ['OVERDUE', 'NEAR', 'LATER'] as const;
export type Bucket = (typeof BUCKETS)[number];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

export interface WorkItem {
  id: string;
  kind: WorkKind;
  title: string;
  subtitle: string | null;
  status: string;
  dueOn: string | null;
  originalDueOn: string | null;
  bucket: Bucket;
  daysLate: number;
  target: { screen: string; id: string };
}

export interface WorkPage {
  items: WorkItem[];
  nextCursor: string | undefined;
  /** The counts of the whole list, whatever page was read. */
  counts: Record<string, number>;
  /** A source had more than it gives: the list and the counts are a part of the work, not all of it. */
  truncated: boolean;
}

function toItem(raw: unknown): WorkItem | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = oneOf(raw.kind, WORK_KINDS);
  const bucket = oneOf(raw.bucket, BUCKETS);
  if (kind === undefined || bucket === undefined || text(raw.id) === '' || !isRecord(raw.target) || text(raw.target.screen) === '') return undefined;
  return {
    id: text(raw.id),
    kind,
    title: text(raw.title),
    subtitle: nullableText(raw.subtitle),
    status: text(raw.status),
    dueOn: nullableText(raw.due_on),
    originalDueOn: nullableText(raw.original_due_on),
    bucket,
    daysLate: count(raw.days_late),
    target: { screen: text(raw.target.screen), id: text(raw.target.id) },
  };
}

export function toWorkPage(raw: unknown): WorkPage {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items.flatMap((item) => toItem(item) ?? []) : [];
  const counts: Record<string, number> = {};
  if (isRecord(raw) && isRecord(raw.counts)) for (const [key, value] of Object.entries(raw.counts)) counts[key] = count(value);
  return { items, nextCursor: isRecord(raw) && typeof raw.next_cursor === 'string' ? raw.next_cursor : undefined, counts, truncated: isRecord(raw) && raw.truncated === true };
}

/** Where a task is opened from: the screens that take the id in the address do; the ones that do not are opened on their own list. A task whose screen is not known here is shown without a link. */
export function pathOf(item: Pick<WorkItem, 'target'>): string | undefined {
  switch (item.target.screen) {
    case 'PRJ-19':
      return '/prj/prj-19';
    case 'DIS-03':
      return `/dis/dis-03?report=${item.target.id}`;
    case 'MNE-03':
      return `/mne/mne-03?report=${item.target.id}`;
    default:
      return undefined;
  }
}

/** The items of a column, in the order the server gave them. */
export const inBucket = (items: readonly WorkItem[], bucket: Bucket): WorkItem[] => items.filter((item) => item.bucket === bucket);
