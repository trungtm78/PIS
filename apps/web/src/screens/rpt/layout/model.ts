import type { PeriodKind } from '../model';

/**
 * The model of the layout editor (RPT-08, ENT-4b, R23). The user chooses from closed lists, never designs cells: the state here is what the form holds while it is edited, `toParams` is the params of a rule of the
 * type `REPORT_LAYOUT` (the server judges them again with the same schema), and `fromParams` reads the rule in force back so a new version can start from it.
 */
/** Permissions of the steps of a layout (x-permission of the rule store, ADM-11): who writes and submits a version, and who approves it. */
export const MAKE_PERMISSION = 'adm.governance.manage';
export const APPROVE_PERMISSION = 'adm.governance.approve';
export const RULE_TYPE = 'REPORT_LAYOUT';
export const CODE_PATTERN = /^CFG_[A-Z][A-Z0-9_]{1,34}$/;
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
export const INDICATOR_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const RECEIVER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
export const INTERNAL_RECEIVER = 'INTERNAL';
export const REASON_MIN = 5;
export const LIMITS = { indicators: 40, columns: 11, groups: 10 } as const;
export const KINDS = ['INTERNAL', 'AGENCY_REQUEST'] as const;
export type Kind = (typeof KINDS)[number];
export const COLUMN_KEYS = ['project_code', 'project_name', 'owner_unit', 'total_investment', 'plan_year', 'executed_period', 'disbursed_period', 'cumulative_year', 'rate_year', 'status', 'note'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export const SIGNATURES = ['PREPARER', 'CHECKER', 'APPROVER'] as const;
export type Signature = (typeof SIGNATURES)[number];
export const BASES = ['', 'IN_PERIOD', 'YEAR_TO_DATE', 'AS_OF_END', 'FULL_YEAR', 'SAME_PERIOD_LAST_YEAR', 'PREVIOUS_PERIOD'] as const;
export const SCALES = ['VND', 'THOUSAND_VND', 'MILLION_VND', 'BILLION_VND'] as const;
export type Scale = (typeof SCALES)[number];
export const PERIOD_KIND_LIST: readonly PeriodKind[] = ['MONTH', 'QUARTER', 'HALF_YEAR', 'YEAR', 'AS_OF'];

export interface IndicatorRow {
  code: string;
  title: string;
  basis: string;
}
export interface ColumnRow {
  key: ColumnKey;
  title: string;
}
export interface GroupRow {
  key: string;
  title: string;
}

export interface EditorState {
  code: string;
  kind: Kind;
  title: string;
  subtitle: string;
  periodKind: PeriodKind;
  moneyScale: Scale;
  demo: boolean;
  receiver: string;
  agencyName: string;
  requestRef: string;
  provider: string;
  indicators: IndicatorRow[];
  columns: ColumnRow[];
  groups: GroupRow[];
  totals: boolean;
  signatures: Signature[];
  note: string;
  effectiveFrom: string;
  reason: string;
}

export const emptyState = (today: string): EditorState => ({
  code: 'CFG_',
  kind: 'INTERNAL',
  title: '',
  subtitle: '',
  periodKind: 'MONTH',
  moneyScale: 'MILLION_VND',
  demo: false,
  receiver: INTERNAL_RECEIVER,
  agencyName: '',
  requestRef: '',
  provider: '',
  indicators: [{ code: '', title: '', basis: '' }],
  columns: [],
  groups: [],
  totals: true,
  signatures: ['PREPARER', 'APPROVER'],
  note: '',
  effectiveFrom: today,
  reason: '',
});

/** Moves the item at `index` up (-1) or down (+1); out of range is no move. The order of the lists is the order on the form. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

const optional = (value: string): { v: string } | undefined => (value.trim() === '' ? undefined : { v: value.trim() });

/** The params of the rule for the state of the form; the optional words that are empty are left out, as the schema wants. */
export function toParams(state: EditorState): Record<string, unknown> {
  const subtitle = optional(state.subtitle);
  const note = optional(state.note);
  const provider = optional(state.provider);
  const request = optional(state.requestRef);
  const agency = state.kind === 'AGENCY_REQUEST' ? { name: state.agencyName.trim(), ...(request === undefined ? {} : { request_ref: request.v }) } : undefined;
  return {
    kind: state.kind,
    title: state.title.trim(),
    ...(subtitle === undefined ? {} : { subtitle: subtitle.v }),
    period_kind: state.periodKind,
    money_scale: state.moneyScale,
    demo: state.demo,
    receiver: state.kind === 'INTERNAL' ? INTERNAL_RECEIVER : state.receiver.trim(),
    ...(agency === undefined ? {} : { agency }),
    ...(provider === undefined ? {} : { data_provider: provider.v }),
    indicators: state.indicators.filter((one) => one.code.trim() !== '').map((one) => ({ code: one.code.trim(), ...(one.title.trim() === '' ? {} : { title: one.title.trim() }), ...(one.basis === '' ? {} : { basis: one.basis }) })),
    columns: state.groups.length === 0 ? [] : state.columns.map((one) => ({ key: one.key, ...(one.title.trim() === '' ? {} : { title: one.title.trim() }) })),
    groups: state.groups.map((one) => ({ key: one.key.trim(), title: one.title.trim() })),
    totals: state.totals,
    signatures: state.signatures,
    ...(note === undefined ? {} : { note: note.v }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Reads the params of a rule in force back into the form; whatever is not there is the empty answer. */
export function fromParams(code: string, params: Record<string, unknown>, today: string): EditorState {
  const base = emptyState(today);
  const agency = isRecord(params.agency) ? params.agency : {};
  return {
    ...base,
    code,
    kind: params.kind === 'AGENCY_REQUEST' ? 'AGENCY_REQUEST' : 'INTERNAL',
    title: str(params.title),
    subtitle: str(params.subtitle),
    periodKind: PERIOD_KIND_LIST.includes(params.period_kind as PeriodKind) ? (params.period_kind as PeriodKind) : base.periodKind,
    moneyScale: (SCALES as readonly string[]).includes(str(params.money_scale)) ? (params.money_scale as Scale) : base.moneyScale,
    demo: params.demo === true,
    receiver: str(params.receiver) || base.receiver,
    agencyName: str(agency.name),
    requestRef: str(agency.request_ref),
    provider: str(params.data_provider),
    indicators: list(params.indicators).filter(isRecord).map((one) => ({ code: str(one.code), title: str(one.title), basis: str(one.basis) })),
    columns: list(params.columns).filter(isRecord).filter((one) => (COLUMN_KEYS as readonly string[]).includes(str(one.key))).map((one) => ({ key: one.key as ColumnKey, title: str(one.title) })),
    groups: list(params.groups).filter(isRecord).map((one) => ({ key: str(one.key), title: str(one.title) })),
    totals: params.totals !== false,
    signatures: list(params.signatures).filter((one): one is Signature => (SIGNATURES as readonly unknown[]).includes(one)),
    note: str(params.note),
  };
}

/** The quick checks the form can make before it asks the server: the first field that is plainly wrong, or undefined. The server judges the whole layout again. */
export function quickProblem(state: EditorState): string | undefined {
  if (!CODE_PATTERN.test(state.code)) return 'code';
  if (state.title.trim() === '') return 'title';
  if (state.kind === 'AGENCY_REQUEST' && (state.agencyName.trim() === '' || !RECEIVER_PATTERN.test(state.receiver.trim()))) return state.agencyName.trim() === '' ? 'agency' : 'receiver';
  for (const one of state.indicators) if (one.code.trim() !== '' && !INDICATOR_PATTERN.test(one.code.trim())) return 'indicators';
  for (const one of state.groups) if (!KEY_PATTERN.test(one.key.trim()) || one.title.trim() === '') return 'groups';
  if (state.indicators.every((one) => one.code.trim() === '') && state.groups.length === 0) return 'indicators';
  return undefined;
}

const PROBLEM_FIELDS = ['code', 'title', 'agency', 'receiver', 'indicators', 'columns', 'groups', 'signatures', 'reason', 'effective_from', 'period_kind', 'params'] as const;

/** The word the screen has a sentence for: the field the server named (`indicators[0].code` is `indicators`), or `other`. */
export function problemOf(field: string | null | undefined): (typeof PROBLEM_FIELDS)[number] | 'other' {
  const head = (field ?? '').split(/[.[]/)[0] ?? '';
  return (PROBLEM_FIELDS as readonly string[]).includes(head) ? (head as (typeof PROBLEM_FIELDS)[number]) : 'other';
}

export const draftProblem = (state: EditorState, today: string): string | undefined => {
  const quick = quickProblem(state);
  if (quick !== undefined) return quick;
  if (state.reason.trim().length < REASON_MIN) return 'reason';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.effectiveFrom) || state.effectiveFrom < today) return 'effective_from';
  return undefined;
};
