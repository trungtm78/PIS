import { isRecord, list, nullableNumber, nullableText, text, toInfo } from './common';
import type { AnaInfo } from './common';

export const RECORD_PERMISSION = 'home.halt.record';
export const PLAN_PERMISSION = 'home.halt.plan';
export const APPROVE_PERMISSION = 'home.halt.approve';
export const CLOSE_PERMISSION = 'home.halt.close';
export const BOTTLENECK_PATH = '/bi/bi-27';
export const HALTED_PATH = '/bi/bi-28';
export const SOURCES = ['PAYMENT', 'LAND', 'ISSUE', 'HALT'] as const;
export type Source = (typeof SOURCES)[number];
export const HALT_STATUSES = ['HALTED', 'RESTART_PLANNED', 'RESTARTED', 'CANCELLED'] as const;
export type HaltStatus = (typeof HALT_STATUSES)[number];
export const PLAN_STATES = ['NO_PLAN', 'AWAITING_APPROVAL', 'ON_TRACK', 'OVERDUE', 'DONE'] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export const STEP_STATUSES = ['OPEN', 'DONE', 'DROPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface Holder {
  kind: string;
  id: string | null;
  name: string | null;
  code: string | null;
}
export interface Item {
  key: string;
  source: Source;
  sourceId: string;
  project: { id: string | null; code: string | null };
  unitId: string | null;
  causeCode: string;
  causeKnown: boolean;
  ownerModule: string | null;
  amountVnd: string | null;
  amountNullReason: string | null;
  since: string;
  ageDays: number;
  bucket: string;
  holder: Holder;
  mergedKeys: string[];
}
export interface TotalRow {
  key: string;
  count: number;
  amountVnd: string;
  noAmount: number;
}
export interface Analysis {
  asOf: string;
  model: { ruleVersion: string; unverified: boolean; causes: Array<{ code: string; ownerModule: string }>; buckets: string[] };
  info: AnaInfo | undefined;
  heldVnd: string;
  noAmount: number;
  merged: number;
  sources: Array<{ source: Source; items: number; skipped: number; cut: boolean }>;
  byCause: TotalRow[];
  byBucket: TotalRow[];
  byHolder: Array<TotalRow & { holder: Holder }>;
  itemsTotal: number;
  items: Item[];
}
interface Person {
  id: string;
  name: string;
}
export interface Step {
  id: string;
  planVersion: number;
  ordinal: number;
  title: string;
  owner: { id: string; name: string | null } | null;
  ownerUnit: { id: string; name: string | null } | null;
  dueOn: string;
  status: StepStatus;
  closeNote: string | null;
}
export interface Dossier {
  id: string;
  project: { id: string; code: string; name: string; status: string };
  unit: { id: string | null; name: string | null };
  reasonCode: string;
  reasonText: string;
  haltedOn: string;
  ageDays: number;
  orderRef: string | null;
  expectedRestartOn: string | null;
  status: HaltStatus;
  plan: { version: number; state: PlanState; savedBy: Person | null; decision: string | null; decidedBy: Person | null; decisionNote: string | null; stepsTotal: number; stepsOpen: number; stepsOverdue: number };
  closeNote: string | null;
  restartedOn: string | null;
  createdBy: Person | null;
  steps: Step[];
}
export interface HaltedList {
  asOf: string;
  items: Dossier[];
  undocumented: Array<{ project: { id: string; code: string; name: string }; unit: { id: string | null; name: string | null } }>;
  causes: Array<{ code: string; ownerModule: string }>;
  planMinSteps: number;
  ruleVersion: string;
  unverified: boolean;
}

const sourceOf = (raw: unknown): Source | undefined => SOURCES.find((one) => one === raw);
const person = (raw: unknown): Person | null => (isRecord(raw) && text(raw.id) !== '' ? { id: text(raw.id), name: text(raw.name) } : null);
const holderOf = (raw: unknown): Holder => (isRecord(raw) ? { kind: text(raw.kind), id: nullableText(raw.id), name: nullableText(raw.name), code: nullableText(raw.code) } : { kind: '', id: null, name: null, code: null });
const totalOf = (raw: unknown): TotalRow | undefined => (isRecord(raw) ? { key: text(raw.key ?? raw.unit_id), count: nullableNumber(raw.count) ?? 0, amountVnd: text(raw.amount_vnd), noAmount: nullableNumber(raw.no_amount) ?? 0 } : undefined);

export function toAnalysis(raw: unknown): Analysis | undefined {
  if (!isRecord(raw) || !isRecord(raw.model) || !Array.isArray(raw.items)) return undefined;
  return {
    asOf: text(raw.as_of),
    model: {
      ruleVersion: text(raw.model.rule_version),
      unverified: raw.model.unverified === true,
      causes: list(raw.model.causes).flatMap((one) => (isRecord(one) && text(one.code) !== '' ? [{ code: text(one.code), ownerModule: text(one.owner_module) }] : [])),
      buckets: list(raw.model.buckets).filter((one): one is string => typeof one === 'string'),
    },
    info: toInfo(raw.info),
    heldVnd: text(raw.held_vnd),
    noAmount: nullableNumber(raw.no_amount) ?? 0,
    merged: nullableNumber(raw.merged) ?? 0,
    sources: list(raw.sources).flatMap((one) => {
      const source = isRecord(one) ? sourceOf(one.source) : undefined;
      return isRecord(one) && source !== undefined ? [{ source, items: nullableNumber(one.items) ?? 0, skipped: nullableNumber(one.skipped) ?? 0, cut: one.cut === true }] : [];
    }),
    byCause: list(raw.by_cause).flatMap((one) => totalOf(one) ?? []),
    byBucket: list(raw.by_bucket).flatMap((one) => totalOf(one) ?? []),
    byHolder: list(raw.by_holder).flatMap((one) => {
      const total = totalOf(one);
      return total === undefined || !isRecord(one) ? [] : [{ ...total, holder: holderOf(one.holder) }];
    }),
    itemsTotal: nullableNumber(raw.items_total) ?? 0,
    items: raw.items.flatMap((one) => {
      const source = isRecord(one) ? sourceOf(one.source) : undefined;
      if (!isRecord(one) || source === undefined || !isRecord(one.project)) return [];
      return [
        {
          key: text(one.key),
          source,
          sourceId: text(one.source_id),
          project: { id: nullableText(one.project.id), code: nullableText(one.project.code) },
          unitId: nullableText(one.unit_id),
          causeCode: text(one.cause_code),
          causeKnown: one.cause_known === true,
          ownerModule: nullableText(one.owner_module),
          amountVnd: nullableText(one.amount_vnd),
          amountNullReason: nullableText(one.amount_null_reason),
          since: text(one.since),
          ageDays: nullableNumber(one.age_days) ?? 0,
          bucket: text(one.bucket),
          holder: holderOf(one.holder),
          mergedKeys: list(one.merged_keys).filter((key): key is string => typeof key === 'string'),
        },
      ];
    }),
  };
}

function toStep(raw: unknown): Step | undefined {
  if (!isRecord(raw) || text(raw.id) === '') return undefined;
  const status = STEP_STATUSES.find((one) => one === raw.status);
  if (status === undefined) return undefined;
  const owner = isRecord(raw.owner) ? { id: text(raw.owner.id), name: nullableText(raw.owner.name) } : null;
  const ownerUnit = isRecord(raw.owner_unit) ? { id: text(raw.owner_unit.id), name: nullableText(raw.owner_unit.name) } : null;
  return { id: text(raw.id), planVersion: nullableNumber(raw.plan_version) ?? 0, ordinal: nullableNumber(raw.ordinal) ?? 0, title: text(raw.title), owner, ownerUnit, dueOn: text(raw.due_on), status, closeNote: nullableText(raw.close_note) };
}

export function toDossier(raw: unknown): Dossier | undefined {
  if (!isRecord(raw) || !isRecord(raw.project) || !isRecord(raw.plan) || !isRecord(raw.unit)) return undefined;
  const status = HALT_STATUSES.find((one) => one === raw.status);
  const state = PLAN_STATES.find((one) => one === (raw.plan as Record<string, unknown>).state);
  if (status === undefined || state === undefined || text(raw.id) === '') return undefined;
  const plan = raw.plan;
  return {
    id: text(raw.id),
    project: { id: text(raw.project.id), code: text(raw.project.code), name: text(raw.project.name), status: text(raw.project.status) },
    unit: { id: nullableText(raw.unit.id), name: nullableText(raw.unit.name) },
    reasonCode: text(raw.reason_code),
    reasonText: text(raw.reason_text),
    haltedOn: text(raw.halted_on),
    ageDays: nullableNumber(raw.age_days) ?? 0,
    orderRef: nullableText(raw.order_ref),
    expectedRestartOn: nullableText(raw.expected_restart_on),
    status,
    plan: { version: nullableNumber(plan.version) ?? 0, state, savedBy: person(plan.saved_by), decision: nullableText(plan.decision), decidedBy: person(plan.decided_by), decisionNote: nullableText(plan.decision_note), stepsTotal: nullableNumber(plan.steps_total) ?? 0, stepsOpen: nullableNumber(plan.steps_open) ?? 0, stepsOverdue: nullableNumber(plan.steps_overdue) ?? 0 },
    closeNote: nullableText(raw.close_note),
    restartedOn: nullableText(raw.restarted_on),
    createdBy: person(raw.created_by),
    steps: list(raw.steps).flatMap((one) => toStep(one) ?? []),
  };
}

export function toHaltedList(raw: unknown): HaltedList | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.undocumented)) return undefined;
  return {
    asOf: text(raw.as_of),
    items: raw.items.flatMap((one) => toDossier(one) ?? []),
    undocumented: raw.undocumented.flatMap((one) =>
      isRecord(one) && isRecord(one.project) && isRecord(one.unit) && text(one.project.id) !== ''
        ? [{ project: { id: text(one.project.id), code: text(one.project.code), name: text(one.project.name) }, unit: { id: nullableText(one.unit.id), name: nullableText(one.unit.name) } }]
        : [],
    ),
    causes: list(raw.causes).flatMap((one) => (isRecord(one) && text(one.code) !== '' ? [{ code: text(one.code), ownerModule: text(one.owner_module) }] : [])),
    planMinSteps: nullableNumber(raw.plan_min_steps) ?? 1,
    ruleVersion: text(raw.rule_version),
    unverified: raw.unverified === true,
  };
}

/** Where the record of an item can be opened: the issue by its id, the dossier by its id, the others at the screen of their module. */
export function sourceLink(item: Pick<Item, 'source' | 'sourceId'>): string {
  switch (item.source) {
    case 'ISSUE':
      return `/iss/iss-03?id=${encodeURIComponent(item.sourceId)}`;
    case 'HALT':
      return `${HALTED_PATH}?id=${encodeURIComponent(item.sourceId)}`;
    case 'PAYMENT':
      return '/pay/pay-03';
    case 'LAND':
      return '/lnd/lnd-07';
  }
}
