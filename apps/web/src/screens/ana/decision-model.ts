import { flag, isRecord, list, nullableNumber, nullableText, text } from './common';

export const DECISION_PERMISSION = 'home.decision.record';
export const DECISION_PATH = '/bi/bi-22';
export const SUBJECT_KINDS = ['KPI_TILE', 'URGENT_ALERT', 'FREE'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const OUTCOMES = ['RESOLVED', 'STILL_OPEN', 'SUPERSEDED'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type FollowUpState = 'NONE' | 'OPEN' | 'DUE_SOON' | 'OVERDUE' | 'RESOLVED' | 'SUPERSEDED';
const FOLLOW_UP_STATES: readonly string[] = ['NONE', 'OPEN', 'DUE_SOON', 'OVERDUE', 'RESOLVED', 'SUPERSEDED'];

export interface Person {
  id: string;
  name: string;
}
export interface DecisionItem {
  id: string;
  subjectKind: SubjectKind;
  metricCode: string | null;
  unitId: string | null;
  unitName: string | null;
  source: string | null;
  sourceId: string | null;
  title: string | null;
  kind: string;
  reason: string;
  headlineValue: string | null;
  headlineReason: string | null;
  followUpOwner: Person | null;
  followUpDue: string | null;
  followUpState: FollowUpState;
  decidedBy: Person;
  decidedAt: string;
  asOfDate: string | null;
  latestOutcome: Outcome | null;
  outcomeCount: number;
  unverified: boolean;
}
export interface DecisionPolicy {
  kinds: string[];
  reasonMin: number;
  reasonMax: number;
  followUpMaxDays: number;
  outcomeNoteMin: number;
  unverified: boolean;
}
export interface DecisionPage {
  items: DecisionItem[];
  nextCursor: string | null;
  asOf: string;
  policy: DecisionPolicy;
}
export interface OutcomeLine {
  id: string;
  outcome: Outcome;
  note: string;
  supersededBy: string | null;
  actor: Person;
  at: string;
}
export interface Comparison {
  metricCode: string;
  then: string | null;
  now: string | null;
  delta: string | null;
  direction: 'UP' | 'DOWN' | 'SAME' | null;
  nullReason: string | null;
}
export interface DecisionDetail extends DecisionItem {
  figuresSha256: string;
  digestOk: boolean;
  snapshotId: string | null;
  frozenTiles: Array<{ metricCode: string; displayValue: string | null; nullReason: string | null }>;
  frozenFigure: { value: string | null; displayValue: string | null; nullReason: string | null } | null;
  frozenAlert: { title: string; severity: string; status: string; consequence: string | null } | null;
  current: { asOfDate: string | null; displayValue: string | null; nullReason: string | null; state: string | null } | null;
  comparison: Comparison | null;
  outcomes: OutcomeLine[];
}

const person = (raw: unknown): Person | null => (isRecord(raw) && text(raw.id) !== '' ? { id: text(raw.id), name: text(raw.name) } : null);
const subjectKind = (raw: unknown): SubjectKind | undefined => SUBJECT_KINDS.find((kind) => kind === raw);
const outcomeOf = (raw: unknown): Outcome | null => OUTCOMES.find((one) => one === raw) ?? null;

export function toDecisionItem(raw: unknown): DecisionItem | undefined {
  if (!isRecord(raw) || !isRecord(raw.subject) || !isRecord(raw.follow_up)) return undefined;
  const kind = subjectKind(raw.subject.kind);
  const decidedBy = person(raw.decided_by);
  if (kind === undefined || decidedBy === null || text(raw.id) === '') return undefined;
  const headline = isRecord(raw.headline) ? raw.headline : null;
  const state = text(raw.follow_up.state);
  return {
    id: text(raw.id),
    subjectKind: kind,
    metricCode: nullableText(raw.subject.metric_code),
    unitId: nullableText(raw.subject.unit_id),
    unitName: nullableText(raw.subject.unit_name),
    source: nullableText(raw.subject.source),
    sourceId: nullableText(raw.subject.source_id),
    title: nullableText(raw.subject.title),
    kind: text(raw.kind),
    reason: text(raw.reason),
    headlineValue: headline === null ? null : nullableText(headline.display_value),
    headlineReason: headline === null ? null : nullableText(headline.null_reason),
    followUpOwner: person(raw.follow_up.owner),
    followUpDue: nullableText(raw.follow_up.due_on),
    followUpState: (FOLLOW_UP_STATES.includes(state) ? state : 'NONE') as FollowUpState,
    decidedBy,
    decidedAt: text(raw.decided_at),
    asOfDate: nullableText(raw.as_of_date),
    latestOutcome: outcomeOf(raw.latest_outcome),
    outcomeCount: nullableNumber(raw.outcome_count) ?? 0,
    unverified: raw.unverified === true,
  };
}

export function toDecisionPage(raw: unknown): DecisionPage | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !isRecord(raw.policy)) return undefined;
  const policy = raw.policy;
  return {
    items: raw.items.flatMap((one) => toDecisionItem(one) ?? []),
    nextCursor: nullableText(raw.next_cursor),
    asOf: text(raw.as_of),
    policy: {
      kinds: list(policy.kinds).filter((kind): kind is string => typeof kind === 'string'),
      reasonMin: nullableNumber(policy.reason_min) ?? 10,
      reasonMax: nullableNumber(policy.reason_max) ?? 1000,
      followUpMaxDays: nullableNumber(policy.follow_up_max_days) ?? 180,
      outcomeNoteMin: nullableNumber(policy.outcome_note_min) ?? 5,
      unverified: policy.unverified === true,
    },
  };
}

export function toDecisionDetail(raw: unknown): DecisionDetail | undefined {
  const item = toDecisionItem(raw);
  if (item === undefined || !isRecord(raw) || !isRecord(raw.figures)) return undefined;
  const figures = raw.figures;
  const figure = isRecord(figures.figure) ? figures.figure : null;
  const alert = isRecord(figures.alert) ? figures.alert : null;
  const current = isRecord(raw.current) ? raw.current : null;
  const comparison = isRecord(raw.comparison) ? raw.comparison : null;
  return {
    ...item,
    figuresSha256: text(raw.figures_sha256),
    digestOk: flag(raw.digest_ok) === true,
    snapshotId: nullableText(raw.snapshot_id),
    frozenTiles: list(figures.tiles).flatMap((tile) => (isRecord(tile) && text(tile.metric_code) !== '' ? [{ metricCode: text(tile.metric_code), displayValue: nullableText(tile.display_value), nullReason: nullableText(tile.null_reason) }] : [])),
    frozenFigure: figure === null ? null : { value: nullableText(figure.value), displayValue: nullableText(figure.display_value), nullReason: nullableText(figure.null_reason) },
    frozenAlert: alert === null ? null : { title: text(alert.title), severity: text(alert.severity), status: text(alert.status), consequence: nullableText(alert.consequence) },
    current: current === null ? null : { asOfDate: nullableText(current.as_of_date), displayValue: nullableText(current.display_value), nullReason: nullableText(current.null_reason), state: nullableText(current.state) },
    comparison:
      comparison === null
        ? null
        : {
            metricCode: text(comparison.metric_code),
            then: nullableText(comparison.then),
            now: nullableText(comparison.now),
            delta: nullableText(comparison.delta),
            direction: comparison.direction === 'UP' || comparison.direction === 'DOWN' || comparison.direction === 'SAME' ? comparison.direction : null,
            nullReason: nullableText(comparison.null_reason),
          },
    outcomes: list(raw.outcomes).flatMap((one) => {
      const actor = isRecord(one) ? person(one.actor) : null;
      const outcome = isRecord(one) ? outcomeOf(one.outcome) : null;
      return isRecord(one) && actor !== null && outcome !== null ? [{ id: text(one.id), outcome, note: text(one.note), supersededBy: nullableText(one.superseded_by), actor, at: text(one.at) }] : [];
    }),
  };
}

/** The link that opens the log with the record dialog ready for a figure of HOME-03 or an urgent alert. */
export function recordLink(subject: { kind: 'KPI_TILE'; metricCode: string; unitId?: string | undefined } | { kind: 'URGENT_ALERT'; source: string; sourceId: string }): string {
  const params = new URLSearchParams(subject.kind === 'KPI_TILE' ? { record: 'KPI_TILE', metric: subject.metricCode, ...(subject.unitId === undefined ? {} : { unit: subject.unitId }) } : { record: 'URGENT_ALERT', source: subject.source, source_id: subject.sourceId });
  return `${DECISION_PATH}?${params.toString()}`;
}
