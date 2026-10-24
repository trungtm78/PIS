import { asRecord, isCalendarDate, nullableText, text, whole } from './model';
import type { FieldProblem } from './model';

/**
 * The first day of the administrative structure that took effect on 1 July 2025 (two-level local government: provinces merged, districts
 * abolished). A working assumption of the design until the legal register entry CXN-34 is confirmed: the screens start from it, and every
 * date is still typed by the steward.
 */
export const REFORM_DATE = '2025-07-01';

export const SUCCESSION_KINDS = ['MERGE', 'SPLIT', 'RENAME', 'RELEVEL', 'ABOLISH_LEVEL'] as const;
export type SuccessionKind = (typeof SUCCESSION_KINDS)[number];

/** The master types whose entries the reform restructured: areas, administrative units and agencies. */
export const STRUCTURE_TYPES = ['AREA', 'ADMIN_UNIT', 'AGENCY'] as const;

export const SUCCESSION_LEGAL_BASIS_MIN_LENGTH = 3;

export type StructureState = 'IN_FORCE' | 'SUCCEEDED' | 'NOT_STARTED' | 'ENDED';
const STATES: readonly string[] = ['IN_FORCE', 'SUCCEEDED', 'NOT_STARTED', 'ENDED'];

export interface StructureVersion {
  id: string;
  revision: number;
  label: string;
  parentRecordId: string | null;
  validFrom: string;
  validUntil: string | null;
}

/** An edge of the graph: which entry took over from which, on what date and basis. */
export interface EdgeView {
  id: string;
  predecessorRecordId: string;
  predecessorKey: string;
  predecessorLabel: string | null;
  successorRecordId: string;
  successorKey: string;
  successorLabel: string | null;
  masterType: string;
  kind: SuccessionKind;
  effectiveDate: string;
  sharePct: string | null;
  legalBasis: string;
  changeRequestId: string;
}

/** An entry of the structure of a date that an entry converts to, with the part of it that went there. */
export interface TargetView {
  recordId: string;
  masterType: string;
  businessKey: string;
  kind: SuccessionKind | null;
  effectiveDate: string | null;
  sharePct: string;
  inForce: boolean;
  version: StructureVersion | null;
}

export interface StructureView {
  recordId: string;
  masterType: string;
  businessKey: string;
  asOf: string;
  state: StructureState;
  structureDate: string | null;
  version: StructureVersion | null;
  predecessors: EdgeView[];
  successors: EdgeView[];
  targets: TargetView[];
}

export interface ConversionView {
  recordId: string;
  masterType: string;
  businessKey: string;
  asOf: string;
  edges: EdgeView[];
  targets: TargetView[];
}

const isKind = (value: string | undefined): value is SuccessionKind => value !== undefined && (SUCCESSION_KINDS as readonly string[]).includes(value);

function toVersion(raw: unknown): StructureVersion | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = text(row.id);
  const revision = whole(row.revision);
  const validFrom = text(row.valid_from);
  if (id === undefined || revision === undefined || validFrom === undefined) return null;
  return { id, revision, label: text(row.label) ?? '', parentRecordId: nullableText(row.parent_record_id), validFrom, validUntil: nullableText(row.valid_until) };
}

export function toEdge(raw: unknown): EdgeView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const kind = text(row.succession_kind);
  const id = text(row.id);
  const predecessorRecordId = text(row.predecessor_record_id);
  const successorRecordId = text(row.successor_record_id);
  const effectiveDate = text(row.effective_date);
  if (id === undefined || predecessorRecordId === undefined || successorRecordId === undefined || effectiveDate === undefined || !isKind(kind)) return undefined;
  return {
    id,
    predecessorRecordId,
    predecessorKey: text(row.predecessor_key) ?? '',
    predecessorLabel: nullableText(row.predecessor_label),
    successorRecordId,
    successorKey: text(row.successor_key) ?? '',
    successorLabel: nullableText(row.successor_label),
    masterType: text(row.master_type) ?? '',
    kind,
    effectiveDate,
    sharePct: nullableText(row.share_pct),
    legalBasis: text(row.legal_basis) ?? '',
    changeRequestId: text(row.change_request_id) ?? '',
  };
}

function toTarget(raw: unknown): TargetView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const recordId = text(row.record_id);
  const businessKey = text(row.business_key);
  const kind = text(row.succession_kind);
  if (recordId === undefined || businessKey === undefined) return undefined;
  return {
    recordId,
    masterType: text(row.master_type) ?? '',
    businessKey,
    kind: isKind(kind) ? kind : null,
    effectiveDate: nullableText(row.effective_date),
    sharePct: text(row.share_pct) ?? '100.00',
    inForce: row.in_force === true,
    version: toVersion(row.version),
  };
}

const list = <T>(value: unknown, read: (item: unknown) => T | undefined): T[] => (Array.isArray(value) ? value.flatMap((item) => read(item) ?? []) : []);

export function toStructure(raw: unknown): StructureView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const recordId = text(row.master_record_id);
  const masterType = text(row.master_type);
  const businessKey = text(row.business_key);
  const asOf = text(row.as_of);
  const state = text(row.state);
  if (recordId === undefined || masterType === undefined || businessKey === undefined || asOf === undefined || state === undefined || !STATES.includes(state)) return undefined;
  return {
    recordId,
    masterType,
    businessKey,
    asOf,
    state: state as StructureState,
    structureDate: nullableText(row.structure_date),
    version: toVersion(row.version),
    predecessors: list(row.predecessors, toEdge),
    successors: list(row.successors, toEdge),
    targets: list(row.targets, toTarget),
  };
}

export function toConversion(raw: unknown): ConversionView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const recordId = text(row.master_record_id);
  const masterType = text(row.master_type);
  const businessKey = text(row.business_key);
  const asOf = text(row.as_of);
  if (recordId === undefined || masterType === undefined || businessKey === undefined || asOf === undefined) return undefined;
  return { recordId, masterType, businessKey, asOf, edges: list(row.edges, toEdge), targets: list(row.targets, toTarget) };
}

/** The proposal of a SUCCESSION change request as the reviewer reads it: the kind, the date, the basis and the successors with their shares. */
export interface ProposedSuccession {
  kind: SuccessionKind;
  effectiveDate: string;
  legalBasis: string;
  edges: Array<{ successorRecordId: string; sharePct: string | null }>;
}

export function toProposedSuccession(proposed: Record<string, unknown>): ProposedSuccession | undefined {
  const kind = text(proposed.succession_kind);
  const effectiveDate = text(proposed.effective_date);
  if (!isKind(kind) || effectiveDate === undefined || !Array.isArray(proposed.edges)) return undefined;
  return {
    kind,
    effectiveDate,
    legalBasis: text(proposed.legal_basis) ?? '',
    edges: proposed.edges.flatMap((item: unknown) => {
      const edge = asRecord(item);
      const successorRecordId = text(edge?.successor_record_id);
      return successorRecordId === undefined ? [] : [{ successorRecordId, sharePct: nullableText(edge?.share_pct) }];
    }),
  };
}

/** Today's date in the business time zone, so that the default date of a screen does not depend on the zone of the browser. */
export function vietnamToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ---- the tree of MDM-37 ----------------------------------------------------------------------------------------------------------------

/** The day before a calendar date (UTC arithmetic on the date alone: no time zone is involved). */
export function dayBefore(date: string): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() - 1);
  return moved.toISOString().slice(0, 10);
}

/** The edges that connect the structure before a date with the one from it: the successions effective on that date. */
export function edgesOn(edges: readonly EdgeView[], date: string): EdgeView[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (edge.effectiveDate !== date || seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

export interface Connector {
  id: string;
  /** The entries before the date, by key, with the name they had when they handed over. */
  before: Array<{ recordId: string; key: string; label: string | null }>;
  /** The entries from the date, by key, with the share of a split. */
  after: Array<{ recordId: string; key: string; label: string | null; sharePct: string | null }>;
  kinds: SuccessionKind[];
  legalBasis: string;
  changeRequestId: string;
}

/**
 * The edges grouped into the connectors of the tree: edges that share an entry belong to one connector, so a merge reads as several entries
 * joined into one and a split as one entry parted into several, each with its kind.
 */
export function connectorsOf(edges: readonly EdgeView[]): Connector[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) {
    parent.set(find(edge.predecessorRecordId), find(edge.successorRecordId));
  }
  const groups = new Map<string, EdgeView[]>();
  for (const edge of edges) groups.set(find(edge.predecessorRecordId), [...(groups.get(find(edge.predecessorRecordId)) ?? []), edge]);
  return [...groups.entries()]
    .map(([root, members]) => {
      const before = new Map<string, { key: string; label: string | null }>();
      const after = new Map<string, { key: string; label: string | null; sharePct: string | null }>();
      for (const edge of members) {
        before.set(edge.predecessorRecordId, { key: edge.predecessorKey, label: edge.predecessorLabel });
        after.set(edge.successorRecordId, { key: edge.successorKey, label: edge.successorLabel, sharePct: edge.sharePct });
      }
      return {
        id: root,
        before: [...before.entries()].map(([recordId, value]) => ({ recordId, ...value })).sort((left, right) => left.key.localeCompare(right.key)),
        after: [...after.entries()].map(([recordId, value]) => ({ recordId, ...value })).sort((left, right) => left.key.localeCompare(right.key)),
        kinds: [...new Set(members.map((edge) => edge.kind))],
        legalBasis: members[0]?.legalBasis ?? '',
        changeRequestId: members[0]?.changeRequestId ?? '',
      };
    })
    .sort((left, right) => (left.before[0]?.key ?? '').localeCompare(right.before[0]?.key ?? ''));
}

// ---- the form of MDM-37 ----------------------------------------------------------------------------------------------------------------

export interface SuccessionForm {
  masterType: string;
  predecessorId: string;
  successorId: string;
  kind: SuccessionKind;
  effectiveDate: string;
  sharePct: string;
  legalBasis: string;
  reason: string;
}

export type SuccessionField = keyof SuccessionForm;

/** What a field of this form can be wrong with: the shared problems and the ones of a share or of two keys that name the same entry. */
export type SuccessionProblem = FieldProblem | 'invalidShare' | 'sameEntry';

export const EMPTY_SUCCESSION_FORM: SuccessionForm = {
  masterType: 'AREA',
  predecessorId: '',
  successorId: '',
  kind: 'MERGE',
  effectiveDate: REFORM_DATE,
  sharePct: '',
  legalBasis: '',
  reason: '',
};

const TEXT_MAX_LENGTH = 2000;
const REASON_MIN_LENGTH = 5;
const SHARE = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** True for a share of a split: more than 0 and less than 100 percent, with at most two decimals. */
export function isShare(value: string): boolean {
  const match = SHARE.exec(value.trim());
  if (match === null) return false;
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return hundredths > 0 && hundredths < 10_000;
}

export function validateSuccession(form: SuccessionForm): Partial<Record<SuccessionField, SuccessionProblem>> {
  const errors: Partial<Record<SuccessionField, SuccessionProblem>> = {};
  if (form.masterType.trim() === '') errors.masterType = 'required';
  if (form.predecessorId === '') errors.predecessorId = 'required';
  if (form.successorId === '') errors.successorId = 'required';
  else if (form.successorId === form.predecessorId) errors.successorId = 'sameEntry';
  if (form.effectiveDate.trim() === '') errors.effectiveDate = 'required';
  else if (!isCalendarDate(form.effectiveDate)) errors.effectiveDate = 'invalidDate';
  if (form.kind === 'SPLIT') {
    if (form.sharePct.trim() === '') errors.sharePct = 'required';
    else if (!isShare(form.sharePct)) errors.sharePct = 'invalidShare';
  }
  const basis = form.legalBasis.trim();
  if (basis === '') errors.legalBasis = 'required';
  else if (basis.length < SUCCESSION_LEGAL_BASIS_MIN_LENGTH) errors.legalBasis = 'tooShort';
  else if (basis.length > TEXT_MAX_LENGTH) errors.legalBasis = 'tooLong';
  const reason = form.reason.trim();
  if (reason === '') errors.reason = 'required';
  else if (reason.length < REASON_MIN_LENGTH) errors.reason = 'tooShort';
  else if (reason.length > TEXT_MAX_LENGTH) errors.reason = 'tooLong';
  return errors;
}
