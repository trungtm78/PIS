import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import { absencePolicyOf } from './alert-coverage.ts';
import { MAX_DELEGATION_DAYS } from './adm-delegation.ts';
import { csvLine } from './dis-export.ts';
import type { DoaRuleContent } from './doa.ts';
import { REPORT_ACCEPT_BUSINESS_TYPE, REPORT_STEP_KINDS, reportWorkflowDefect } from './dis-report-workflow.ts';
import type { ReportStepKind } from './dis-report-workflow.ts';
import { STANDING_REVIEW_MAX_DAYS } from './iam-standing-delegation.ts';
import type { JudgedRow, MigrationMapping, RowError } from './migration-batch.ts';

/**
 * The organisation pack (ENT-3d, HT.02, HT.03, QT.01, MD.03 of the customer spec): the organisation of one tenant as data, so that the same pack can be judged, loaded through the ADM migration batch (register, dry run, apply by
 * another person), materialised into the tables that already exist, verified, and shown. A pack names units (a tree), roles with their scope and permissions, seats (which role is held where, by how many people: never who), the
 * staged approval of a report, the delegation defaults, the directory groups that fill the seats and the entries of the shared catalogues. It contains no person and no account. Everything here is pure.
 */

export const ORG_PACK_ENTITY = 'ORG_PACK';
export const ORG_PACK_MAPPING_VERSION = 'ORG-PACK-1';
export const ORG_PACK_COLUMNS = ['business_key', 'kind', 'name', 'parent_key', 'data', 'pack'] as const;
export const ORG_PACK_ROW_KINDS = ['UNIT', 'ROLE', 'SEAT', 'STEP', 'POLICY', 'DOA', 'ENTRY'] as const;
export type OrgPackRowKind = (typeof ORG_PACK_ROW_KINDS)[number];

/** What a unit is for in the report chain: the root of the organisation, a point that enters data, the unit that aggregates and closes, the leadership that reads, the unit that administers. */
export const UNIT_FUNCTIONS = ['ROOT', 'INPUT_POINT', 'AGGREGATOR', 'LEADERSHIP', 'ADMINISTRATION'] as const;
export type UnitFunction = (typeof UNIT_FUNCTIONS)[number];

/** The five kinds of role of the report chain (HT.02): entry, approval in the unit, review and close by the planning unit, leadership view, administration. */
export const ROLE_KINDS = ['ENTRY', 'UNIT_APPROVER', 'PLANNING_REVIEWER', 'LEADERSHIP_VIEWER', 'ADMINISTRATOR'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const SEAT_SCOPES = ['UNIT_ONLY', 'UNIT_SUBTREE', 'TENANT'] as const;
export type SeatScope = (typeof SEAT_SCOPES)[number];

/** The role kind of a seat decides the scope it is held with and the kind of unit it sits in: the entry and the approval are held in the unit and for the unit only, the others over the whole tenant. */
const SEAT_RULES: Readonly<Record<RoleKind, { scope: SeatScope; unit: UnitFunction }>> = {
  ENTRY: { scope: 'UNIT_ONLY', unit: 'INPUT_POINT' },
  UNIT_APPROVER: { scope: 'UNIT_ONLY', unit: 'INPUT_POINT' },
  PLANNING_REVIEWER: { scope: 'TENANT', unit: 'AGGREGATOR' },
  LEADERSHIP_VIEWER: { scope: 'TENANT', unit: 'LEADERSHIP' },
  ADMINISTRATOR: { scope: 'TENANT', unit: 'ADMINISTRATION' },
};

/** The suffix of the directory group of a seat, by role kind. */
export const GROUP_SUFFIX: Readonly<Record<RoleKind, string>> = { ENTRY: 'ENTRY', UNIT_APPROVER: 'APPROVER', PLANNING_REVIEWER: 'REVIEW', LEADERSHIP_VIEWER: 'LEADER', ADMINISTRATOR: 'ADMIN' };

/** Permissions that decide something about data that somebody else entered. Only the roles that decide hold them: not entry, not the administrators, never the viewers. */
export const DECISION_PERMISSIONS: readonly string[] = ['approval.decide', 'report.review', 'funding.figure.accept', 'rpt.approve', 'rpt.issue', 'period.lock', 'period.reopen.approve', 'hpm.push', 'hpm.receipt'];
const READ_VERBS = ['read', 'query', 'list', 'view'];
/** Rights that every working role holds because they are about the person's own work and not about the data: handing the work over (HT.03) and asking to act for somebody. */
const WORK_RIGHTS: readonly string[] = ['iam.delegation.create', 'iam.acting.request'];
/** The permissions of a closing step: a unit approver confirms the data of the unit and does not close the period or push it. */
const PLANNING_ONLY_PERMISSIONS: readonly string[] = ['period.lock', 'period.reopen.approve', 'hpm.push', 'hpm.receipt'];
export const PLANNING_MIN_HOLDERS = 2;
export const ADMIN_MIN_HOLDERS = 2;

export interface PackUnit {
  code: string;
  name: string;
  parentCode: string | null;
  function: UnitFunction;
  /** True while the customer has not yet named the unit (the spec's "[name of the 02 project teams]"). */
  placeholder: boolean;
}
export interface PackRole {
  code: string;
  name: string;
  kind: RoleKind;
  rank: number;
  permissions: readonly string[];
}
export interface PackSeat {
  roleCode: string;
  unitCode: string;
  scope: SeatScope;
  minHolders: number;
  maxHolders: number;
}
export interface PackStep {
  id: string;
  kind: ReportStepKind;
  name: string;
  /** `DOA` takes the approvers from the matrix of authority; `ROLE_IN_UNIT` names the role and the unit. */
  assignee: 'DOA' | 'ROLE_IN_UNIT';
  roleCode?: string;
  unitCode?: string;
  slaWorkingHours: number;
  onTimeout: 'REMIND' | 'EXPIRE';
}
export interface PackDelegation {
  /** The roles whose holders may hand their work over (entry, approval). */
  delegableRoles: readonly string[];
  /** A time-boxed delegation lasts at most this many days (the platform limit is 90). */
  maxDays: number;
  /** A standing delegation (a change of staff) is reviewed by its delegator at least this often, in days. */
  standingReviewDays: number;
}
export interface PackAbsence {
  [key: string]: unknown;
}
export interface PackDoa {
  documentType: string;
  unitCode: string;
  roleCode: string;
  approvalLevels: number;
}
export interface PackEntry {
  masterType: string;
  key: string;
  label: string;
  parentKey: string | null;
  attributes: Record<string, unknown>;
}
export interface OrgPack {
  /** The label of the pack: `PVFCCO-TEMPLATE` marks the pack as illustrative; every row carries it. */
  label: string;
  /** The directory group prefix (inside the `MACHVON-` filter), for example `MACHVON-PVFCCO`. */
  directoryPrefix: string;
  units: readonly PackUnit[];
  roles: readonly PackRole[];
  seats: readonly PackSeat[];
  steps: readonly PackStep[];
  delegation: PackDelegation;
  absence: PackAbsence;
  doa: PackDoa;
  entries: readonly PackEntry[];
}

export interface PackDefect {
  code: string;
  /** The business key of the row at fault, or `PACK`. */
  key: string;
  field: string;
  message: string;
}

const UNIT_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const ROLE_CODE = /^[A-Z][A-Z0-9_]{1,59}$/;
const STEP_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const PACK_LABEL = /^[A-Z][A-Z0-9-]{2,39}$/;
const DIRECTORY_PREFIX = /^MACHVON-[A-Z0-9][A-Z0-9-]{1,30}$/;
const ENTRY_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ENTRY_TYPE = /^[A-Z][A-Z0-9_]{1,49}$/;
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/;
const MAX_UNIT_DEPTH = 8;
const MAX_ENTRY_DEPTH = 4;
/** A fixed identifier standing for the planning unit while the shape of the rule is judged: the real identifiers exist only after the units do. */
const PROBE_UNIT_ID = '00000000-0000-4000-8000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export const unitKey = (code: string): string => `UNIT:${code}`;
export const roleKey = (code: string): string => `ROLE:${code}`;
export const seatKey = (roleCode: string, unitCode: string): string => `SEAT:${roleCode}@${unitCode}`;
export const stepKey = (id: string): string => `STEP:${id}`;
export const policyKey = (name: 'ABSENCE' | 'DELEGATION' | 'DIRECTORY'): string => `POLICY:${name}`;
export const doaKey = (documentType: string): string => `DOA:${documentType}`;
export const entryKey = (masterType: string, key: string): string => `ENTRY:${masterType}:${key}`;

/** The name of the directory group that fills a seat: `<prefix>-<UNIT>-<SUFFIX>`, upper case, inside the `MACHVON-*` filter of the directory import. */
export function directoryGroupOf(pack: Pick<OrgPack, 'directoryPrefix'>, role: Pick<PackRole, 'kind'>, unitCode: string): string {
  return `${pack.directoryPrefix}-${unitCode.replace(/_/g, '-')}-${GROUP_SUFFIX[role.kind]}`;
}

/** The directory groups of a pack with the role, scope and unit each one grants: what the directory team creates and what `ad-group-role-map.json` states under `tenantMappings`. */
export function directoryMappings(pack: OrgPack): Array<{ adGroup: string; tenantRole: string; scopeKind: SeatScope; unit: string }> {
  const roles = new Map(pack.roles.map((role) => [role.code, role]));
  return pack.seats.flatMap((seat) => {
    const role = roles.get(seat.roleCode);
    return role === undefined ? [] : [{ adGroup: directoryGroupOf(pack, role, seat.unitCode), tenantRole: role.code, scopeKind: seat.scope, unit: seat.unitCode }];
  });
}

// -- Rows ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A row of the pack file as the migration judge hands it over. */
export interface PackRow {
  rowNumber: number;
  businessKey: string;
  payload: Readonly<Record<string, string>>;
}

const dataOf = (payload: Readonly<Record<string, string>>): Record<string, unknown> | undefined => {
  const raw = payload.data;
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const stringList = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined);

/** The pack that a set of rows says, and the defects of the rows themselves (a cell that is not what the kind of row needs). The pack is as far as the rows go: it is judged by `judgeOrgPack`. */
export function orgPackOfRows(rows: readonly PackRow[]): { pack: OrgPack; defects: PackDefect[] } {
  const defects: PackDefect[] = [];
  const bad = (code: string, key: string, field: string, message: string): void => void defects.push({ code, key, field, message });
  const units: PackUnit[] = [];
  const roles: PackRole[] = [];
  const seats: PackSeat[] = [];
  const orderedSteps: Array<{ order: number; step: PackStep }> = [];
  const entries: PackEntry[] = [];
  const labels = new Set<string>();
  let directoryPrefix = '';
  let delegation: PackDelegation = { delegableRoles: [], maxDays: 0, standingReviewDays: 0 };
  let absence: PackAbsence = {};
  let doa: PackDoa = { documentType: '', unitCode: '', roleCode: '', approvalLevels: 0 };
  const seen = new Set<string>();

  for (const row of rows) {
    const key = row.businessKey;
    const kind = ORG_PACK_ROW_KINDS.find((candidate) => key.startsWith(`${candidate}:`));
    if (kind === undefined || row.payload.kind !== kind) {
      bad('ROW_KIND', key, 'kind', 'the business key and the kind of the row must agree and name a kind the pack knows');
      continue;
    }
    labels.add(row.payload.pack ?? '');
    if (row.payload.pack === undefined) bad('PACK_LABEL', key, 'pack', 'every row carries the label of the pack');
    const data = dataOf(row.payload);
    if (data === undefined) {
      bad('DATA_NOT_JSON', key, 'data', 'data is a JSON object');
      continue;
    }
    const name = row.payload.name ?? '';
    const parent = row.payload.parent_key ?? '';
    const expect = (expected: string): void => {
      if (key !== expected) bad('KEY_MISMATCH', key, 'business_key', `the business key of this row is ${expected}`);
      if (seen.has(expected)) bad('DUPLICATE_ROW', key, 'business_key', 'the row is listed twice');
      seen.add(expected);
    };
    if (kind === 'UNIT') {
      const code = key.slice('UNIT:'.length);
      expect(unitKey(code));
      const func = UNIT_FUNCTIONS.find((candidate) => candidate === data.function);
      if (func === undefined) bad('UNIT_FUNCTION', key, 'data.function', `the function of a unit is one of ${UNIT_FUNCTIONS.join(', ')}`);
      units.push({ code, name, parentCode: parent === '' ? null : parent, function: func ?? 'INPUT_POINT', placeholder: data.placeholder === true });
    } else if (kind === 'ROLE') {
      const code = key.slice('ROLE:'.length);
      expect(roleKey(code));
      const roleKind = ROLE_KINDS.find((candidate) => candidate === data.kind);
      const permissions = stringList(data.permissions);
      if (roleKind === undefined) bad('ROLE_KIND', key, 'data.kind', `the kind of a role is one of ${ROLE_KINDS.join(', ')}`);
      if (permissions === undefined) bad('ROLE_PERMISSIONS', key, 'data.permissions', 'permissions is a list of names');
      if (typeof data.rank !== 'number') bad('ROLE_RANK', key, 'data.rank', 'rank is a number');
      roles.push({ code, name, kind: roleKind ?? 'ENTRY', rank: typeof data.rank === 'number' ? data.rank : 0, permissions: permissions ?? [] });
    } else if (kind === 'SEAT') {
      const roleCode = text(data.role);
      const unitCode = text(data.unit);
      expect(seatKey(roleCode, unitCode));
      const scope = SEAT_SCOPES.find((candidate) => candidate === data.scope);
      if (scope === undefined) bad('SEAT_SCOPE', key, 'data.scope', `the scope of a seat is one of ${SEAT_SCOPES.join(', ')}`);
      seats.push({ roleCode, unitCode, scope: scope ?? 'UNIT_ONLY', minHolders: Number(data.min), maxHolders: Number(data.max) });
    } else if (kind === 'STEP') {
      const id = key.slice('STEP:'.length);
      expect(stepKey(id));
      const stepKind = REPORT_STEP_KINDS.find((candidate) => candidate === data.kind);
      if (stepKind === undefined) bad('STEP_KIND', key, 'data.kind', `the kind of a step is one of ${REPORT_STEP_KINDS.join(', ')}`);
      const assignee = data.assignee === 'DOA' || data.assignee === 'ROLE_IN_UNIT' ? data.assignee : undefined;
      if (assignee === undefined) bad('STEP_ASSIGNEE', key, 'data.assignee', 'assignee is DOA or ROLE_IN_UNIT');
      const onTimeout = data.on_timeout === 'EXPIRE' ? 'EXPIRE' : data.on_timeout === 'REMIND' ? 'REMIND' : undefined;
      if (onTimeout === undefined) bad('STEP_TIMEOUT', key, 'data.on_timeout', 'on_timeout is REMIND or EXPIRE (an escalation names a person, which a template cannot)');
      if (!Number.isInteger(data.order) || (data.order as number) < 1) bad('STEP_ORDER', key, 'data.order', 'order is the place of the step in the chain, a whole number from 1');
      orderedSteps.push({ order: Number(data.order), step: {
        id,
        kind: stepKind ?? 'UNIT_APPROVER',
        name,
        assignee: assignee ?? 'DOA',
        ...(typeof data.role === 'string' ? { roleCode: data.role } : {}),
        ...(typeof data.unit === 'string' ? { unitCode: data.unit } : {}),
        slaWorkingHours: Number(data.sla_working_hours),
        onTimeout: onTimeout ?? 'REMIND',
      } });
    } else if (kind === 'POLICY') {
      const which = key.slice('POLICY:'.length);
      if (which === 'ABSENCE') {
        expect(policyKey('ABSENCE'));
        absence = data;
      } else if (which === 'DELEGATION') {
        expect(policyKey('DELEGATION'));
        const delegable = stringList(data.delegable_roles);
        if (delegable === undefined) bad('DELEGATION_ROLES', key, 'data.delegable_roles', 'delegable_roles is a list of role codes');
        delegation = { delegableRoles: delegable ?? [], maxDays: Number(data.max_days), standingReviewDays: Number(data.standing_review_days) };
      } else if (which === 'DIRECTORY') {
        expect(policyKey('DIRECTORY'));
        directoryPrefix = text(data.prefix);
      } else bad('POLICY_UNKNOWN', key, 'business_key', 'a policy is ABSENCE, DELEGATION or DIRECTORY');
    } else if (kind === 'DOA') {
      const documentType = key.slice('DOA:'.length);
      expect(doaKey(documentType));
      doa = { documentType, unitCode: text(data.unit), roleCode: text(data.role), approvalLevels: Number(data.approval_levels) };
    } else {
      const masterType = text(data.type);
      const entry = text(data.key);
      expect(entryKey(masterType, entry));
      entries.push({ masterType, key: entry, label: name, parentKey: parent === '' ? null : parent, attributes: isRecord(data.attributes) ? data.attributes : {} });
    }
  }
  // The rows of a pack come back from the database in no order: the chain is the order the file states.
  const steps = orderedSteps.sort((a, b) => a.order - b.order).map((one) => one.step);
  if (new Set(orderedSteps.map((one) => one.order)).size !== orderedSteps.length) bad('STEP_ORDER', 'PACK', 'steps', 'every step has its own place in the chain');
  const label = [...labels][0] ?? '';
  if (labels.size > 1) bad('PACK_LABEL', 'PACK', 'pack', 'all rows carry the same label of the pack');
  return { pack: { label, directoryPrefix, units, roles, seats, steps, delegation, absence, doa, entries }, defects };
}

const dataOfUnit = (unit: PackUnit): string => JSON.stringify({ function: unit.function, ...(unit.placeholder ? { placeholder: true } : {}) });

/** The rows of a pack, in a fixed order: this is the file a person registers. */
export function orgPackRows(pack: OrgPack): Array<Record<(typeof ORG_PACK_COLUMNS)[number], string>> {
  const row = (businessKey: string, kind: OrgPackRowKind, name: string, parentKey: string, data: unknown): Record<(typeof ORG_PACK_COLUMNS)[number], string> => ({
    business_key: businessKey,
    kind,
    name,
    parent_key: parentKey,
    data: JSON.stringify(data),
    pack: pack.label,
  });
  return [
    row(policyKey('DIRECTORY'), 'POLICY', '', '', { prefix: pack.directoryPrefix }),
    ...pack.units.map((unit) => ({ ...row(unitKey(unit.code), 'UNIT', unit.name, unit.parentCode ?? '', {}), data: dataOfUnit(unit) })),
    ...pack.roles.map((role) => row(roleKey(role.code), 'ROLE', role.name, '', { kind: role.kind, rank: role.rank, permissions: role.permissions })),
    ...pack.seats.map((seat) => row(seatKey(seat.roleCode, seat.unitCode), 'SEAT', '', '', { role: seat.roleCode, unit: seat.unitCode, scope: seat.scope, min: seat.minHolders, max: seat.maxHolders })),
    ...pack.steps.map((step, at) =>
      row(stepKey(step.id), 'STEP', step.name, '', {
        order: at + 1,
        kind: step.kind,
        assignee: step.assignee,
        ...(step.roleCode === undefined ? {} : { role: step.roleCode }),
        ...(step.unitCode === undefined ? {} : { unit: step.unitCode }),
        sla_working_hours: step.slaWorkingHours,
        on_timeout: step.onTimeout,
      }),
    ),
    row(policyKey('DELEGATION'), 'POLICY', '', '', { delegable_roles: pack.delegation.delegableRoles, max_days: pack.delegation.maxDays, standing_review_days: pack.delegation.standingReviewDays }),
    row(policyKey('ABSENCE'), 'POLICY', '', '', pack.absence),
    row(doaKey(pack.doa.documentType), 'DOA', '', '', { unit: pack.doa.unitCode, role: pack.doa.roleCode, approval_levels: pack.doa.approvalLevels }),
    ...pack.entries.map((entry) => row(entryKey(entry.masterType, entry.key), 'ENTRY', entry.label, entry.parentKey ?? '', { type: entry.masterType, key: entry.key, attributes: entry.attributes })),
  ];
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The file of a pack: UTF-8 with a byte-order mark and CRLF lines, the header first. */
export function orgPackCsv(pack: OrgPack): string {
  const lines = [csvLine([...ORG_PACK_COLUMNS]), ...orgPackRows(pack).map((row) => csvLine(ORG_PACK_COLUMNS.map((column) => row[column])))];
  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
}

/** The digest of the pack: the same pack always has the same digest, whatever order the rows came in. */
export const orgPackDigest = (pack: OrgPack): string => sha256Hex(canonicalJson(orgPackRows(pack).sort((a, b) => a.business_key.localeCompare(b.business_key))));

// -- Judgement ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const isReadOnly = (permission: string): boolean => READ_VERBS.includes(permission.split('.').pop() ?? '') || permission.endsWith('.self');
const holds = (role: PackRole, permission: string): boolean => role.permissions.includes(permission);

/**
 * Judges a pack as a whole. The tree is a tree (one root, known parents, no cycle, at most 8 deep); there is one role of each kind and a role holds only names that look like permissions; every seat is held with the scope
 * and in the kind of unit that its role kind needs; each input point has exactly one entry and one approver seat of one holder (the agreement of the minutes 43/BBH-KHDT); the planning unit and the administration have at least
 * two holders (review, close and push are not one person's, and the loader is applied by somebody other than who registered it); the roles are segregated (the person who enters does not decide, the viewers only read, the
 * administrators decide nothing); the staged approval is the chain the platform runs, each step with its deadline; the absence policy, the delegation defaults and the matrix rule are what the platform accepts; the catalogue
 * entries are well formed trees. A defect names the row and the field.
 */
export function judgeOrgPack(pack: OrgPack): PackDefect[] {
  const defects: PackDefect[] = [];
  const bad = (code: string, key: string, field: string, message: string): void => void defects.push({ code, key, field, message });

  if (!PACK_LABEL.test(pack.label)) bad('PACK_LABEL', 'PACK', 'pack', 'the label of the pack is upper-case words joined by -, for example PVFCCO-TEMPLATE');
  if (!DIRECTORY_PREFIX.test(pack.directoryPrefix)) bad('DIRECTORY_PREFIX', policyKey('DIRECTORY'), 'data.prefix', 'the directory prefix starts with MACHVON- so that the directory import filter takes the groups');

  // Units.
  const unitByCode = new Map<string, PackUnit>();
  for (const unit of pack.units) {
    const key = unitKey(unit.code);
    if (!UNIT_CODE.test(unit.code)) bad('UNIT_CODE', key, 'business_key', 'a unit code is upper case letters, digits and _, 2 to 40 characters');
    if (unit.name.trim().length < 2 || unit.name.length > 200) bad('UNIT_NAME', key, 'name', 'a unit has a name of 2 to 200 characters');
    if (unitByCode.has(unit.code)) bad('UNIT_DUPLICATE', key, 'business_key', 'a unit code is used once');
    unitByCode.set(unit.code, unit);
    if (unit.placeholder && unit.function !== 'INPUT_POINT') bad('UNIT_PLACEHOLDER', key, 'data.placeholder', 'only an input point can wait for its name');
  }
  const roots = pack.units.filter((unit) => unit.parentCode === null);
  if (roots.length !== 1 || roots[0]?.function !== 'ROOT') bad('UNIT_ROOT', 'PACK', 'units', 'the tree has one root, whose function is ROOT');
  for (const unit of pack.units) {
    if (unit.function === 'ROOT' && unit.parentCode !== null) bad('UNIT_ROOT', unitKey(unit.code), 'parent_key', 'the root has no parent');
    if (unit.parentCode !== null && !unitByCode.has(unit.parentCode)) bad('UNIT_PARENT', unitKey(unit.code), 'parent_key', 'the parent is a unit of the pack');
  }
  for (const unit of pack.units) {
    let depth = 0;
    let at: PackUnit | undefined = unit;
    const visited = new Set<string>();
    while (at?.parentCode !== undefined && at.parentCode !== null) {
      if (visited.has(at.code)) {
        bad('UNIT_CYCLE', unitKey(unit.code), 'parent_key', 'the units form a cycle');
        break;
      }
      visited.add(at.code);
      at = unitByCode.get(at.parentCode);
      depth += 1;
    }
    if (depth > MAX_UNIT_DEPTH) bad('UNIT_DEPTH', unitKey(unit.code), 'parent_key', `the tree is at most ${MAX_UNIT_DEPTH} deep`);
  }
  const ofFunction = (func: UnitFunction): PackUnit[] => pack.units.filter((unit) => unit.function === func);
  if (ofFunction('INPUT_POINT').length === 0) bad('INPUT_POINTS', 'PACK', 'units', 'at least one input point');
  if (ofFunction('AGGREGATOR').length !== 1) bad('AGGREGATOR', 'PACK', 'units', 'exactly one unit aggregates, reviews and closes');

  // Roles.
  const roleByCode = new Map<string, PackRole>();
  for (const role of pack.roles) {
    const key = roleKey(role.code);
    if (!ROLE_CODE.test(role.code)) bad('ROLE_CODE', key, 'business_key', 'a role code is upper case letters, digits and _, 2 to 60 characters');
    if (role.name.trim().length < 2 || role.name.length > 120) bad('ROLE_NAME', key, 'name', 'a role has a name of 2 to 120 characters');
    if (roleByCode.has(role.code)) bad('ROLE_DUPLICATE', key, 'business_key', 'a role code is used once');
    roleByCode.set(role.code, role);
    if (!Number.isInteger(role.rank) || role.rank < 1 || role.rank > 89) bad('ROLE_RANK', key, 'data.rank', 'the rank of a custom role is a whole number from 1 to 89');
    if (role.permissions.length === 0 || new Set(role.permissions).size !== role.permissions.length || !role.permissions.every((name) => PERMISSION.test(name) && !name.startsWith('system.'))) {
      bad('ROLE_PERMISSIONS', key, 'data.permissions', 'a role holds a list of distinct permission names, none of the control plane');
    }
  }
  const byKind = new Map<RoleKind, PackRole>();
  for (const kind of ROLE_KINDS) {
    const ofKind = pack.roles.filter((role) => role.kind === kind);
    if (ofKind.length !== 1) bad('ROLE_KIND_COUNT', 'PACK', 'roles', `exactly one role of the kind ${kind}`);
    else byKind.set(kind, ofKind[0] as PackRole);
  }
  const entry = byKind.get('ENTRY');
  const approver = byKind.get('UNIT_APPROVER');
  const planner = byKind.get('PLANNING_REVIEWER');
  const viewer = byKind.get('LEADERSHIP_VIEWER');
  const admin = byKind.get('ADMINISTRATOR');
  const writes = (role: PackRole | undefined): string[] => (role === undefined ? [] : role.permissions.filter((name) => !isReadOnly(name) && !WORK_RIGHTS.includes(name)));
  if (viewer !== undefined) for (const name of writes(viewer)) bad('SOD_VIEWER_WRITES', roleKey(viewer.code), 'data.permissions', `the leadership role only reads: ${name} is not a read`);
  for (const role of [entry, admin, viewer]) {
    if (role === undefined) continue;
    for (const name of DECISION_PERMISSIONS) if (holds(role, name) || role.permissions.some((held) => held.endsWith('.*') && name.startsWith(held.slice(0, -1)))) bad('SOD_DECIDES', roleKey(role.code), 'data.permissions', `${role.kind} does not decide: ${name}`);
  }
  if (entry !== undefined && approver !== undefined) for (const name of writes(entry)) if (holds(approver, name)) bad('SOD_ENTRY_APPROVER', roleKey(approver.code), 'data.permissions', `the approver does not enter: ${name} is also the entry role's`);
  if (approver !== undefined) for (const name of PLANNING_ONLY_PERMISSIONS) if (holds(approver, name)) bad('SOD_APPROVER_CLOSES', roleKey(approver.code), 'data.permissions', `the unit approver does not close or push: ${name}`);
  if (planner !== undefined && entry !== undefined) for (const name of writes(entry)) if (holds(planner, name)) bad('SOD_ENTRY_PLANNER', roleKey(planner.code), 'data.permissions', `the planning reviewer does not enter: ${name}`);
  if (admin !== undefined && approver !== undefined) for (const name of writes(approver)) if (holds(admin, name)) bad('SOD_ADMIN_APPROVES', roleKey(admin.code), 'data.permissions', `the administrator does not approve: ${name}`);
  for (const delegable of pack.delegation.delegableRoles) {
    const role = roleByCode.get(delegable);
    if (role === undefined) bad('DELEGATION_ROLE', policyKey('DELEGATION'), 'data.delegable_roles', `${delegable} is a role of the pack`);
    else if (role.kind !== 'ENTRY' && role.kind !== 'UNIT_APPROVER') bad('DELEGATION_ROLE', policyKey('DELEGATION'), 'data.delegable_roles', 'only entry and approval can be handed over');
    else if (!holds(role, 'iam.delegation.create')) bad('DELEGATION_RIGHT', roleKey(role.code), 'data.permissions', 'a role whose work can be delegated holds iam.delegation.create');
  }
  if (pack.delegation.delegableRoles.length === 0) bad('DELEGATION_ROLE', policyKey('DELEGATION'), 'data.delegable_roles', 'entry and approval can be delegated (HT.03)');
  if (!Number.isInteger(pack.delegation.maxDays) || pack.delegation.maxDays < 1 || pack.delegation.maxDays > MAX_DELEGATION_DAYS) bad('DELEGATION_DAYS', policyKey('DELEGATION'), 'data.max_days', `a time-boxed delegation lasts 1 to ${MAX_DELEGATION_DAYS} days`);
  if (!Number.isInteger(pack.delegation.standingReviewDays) || pack.delegation.standingReviewDays < 1 || pack.delegation.standingReviewDays > STANDING_REVIEW_MAX_DAYS) {
    bad('DELEGATION_REVIEW', policyKey('DELEGATION'), 'data.standing_review_days', `a standing delegation is reviewed within 1 to ${STANDING_REVIEW_MAX_DAYS} days`);
  }

  // Seats.
  const seatKeys = new Set<string>();
  for (const seat of pack.seats) {
    const key = seatKey(seat.roleCode, seat.unitCode);
    const role = roleByCode.get(seat.roleCode);
    const unit = unitByCode.get(seat.unitCode);
    if (seatKeys.has(key)) bad('SEAT_DUPLICATE', key, 'business_key', 'a seat is listed once');
    seatKeys.add(key);
    if (role === undefined) bad('SEAT_ROLE', key, 'data.role', 'the role is a role of the pack');
    if (unit === undefined) bad('SEAT_UNIT', key, 'data.unit', 'the unit is a unit of the pack');
    if (role !== undefined) {
      const rule = SEAT_RULES[role.kind];
      if (seat.scope !== rule.scope) bad('SEAT_SCOPE', key, 'data.scope', `${role.kind} is held with the scope ${rule.scope}`);
      if (unit !== undefined && unit.function !== rule.unit) bad('SEAT_UNIT_FUNCTION', key, 'data.unit', `${role.kind} sits in a unit whose function is ${rule.unit}`);
    }
    if (!Number.isInteger(seat.minHolders) || !Number.isInteger(seat.maxHolders) || seat.minHolders < 1 || seat.maxHolders < seat.minHolders || seat.maxHolders > 20) bad('SEAT_HOLDERS', key, 'data.min', 'min and max are whole numbers, 1 <= min <= max <= 20');
  }
  for (const unit of ofFunction('INPUT_POINT')) {
    for (const role of [entry, approver]) {
      if (role === undefined) continue;
      const seats = pack.seats.filter((seat) => seat.roleCode === role.code && seat.unitCode === unit.code);
      const one = seats.length === 1 && seats[0]?.minHolders === 1 && seats[0]?.maxHolders === 1;
      if (!one) bad('SEAT_INPUT_POINT', unitKey(unit.code), 'seats', `an input point has one seat of one holder for ${role.kind}`);
    }
  }
  const needs = (func: UnitFunction, role: PackRole | undefined, minimum: number): void => {
    if (role === undefined) return;
    for (const unit of ofFunction(func)) {
      const seat = pack.seats.find((candidate) => candidate.roleCode === role.code && candidate.unitCode === unit.code);
      if (seat === undefined) bad('SEAT_MISSING', unitKey(unit.code), 'seats', `the unit has a seat for ${role.kind}`);
      else if (seat.minHolders < minimum) bad('SEAT_MIN_HOLDERS', seatKey(role.code, unit.code), 'data.min', `${role.kind} has at least ${minimum} holders`);
    }
  };
  needs('AGGREGATOR', planner, PLANNING_MIN_HOLDERS);
  needs('LEADERSHIP', viewer, 1);
  needs('ADMINISTRATION', admin, ADMIN_MIN_HOLDERS);
  const groups = new Set<string>();
  for (const mapping of directoryMappings(pack)) {
    if (mapping.adGroup.length > 64) bad('DIRECTORY_GROUP', seatKey(mapping.tenantRole, mapping.unit), 'seats', 'a directory group name is at most 64 characters');
    if (groups.has(mapping.adGroup)) bad('DIRECTORY_GROUP', seatKey(mapping.tenantRole, mapping.unit), 'seats', `the directory group ${mapping.adGroup} is used twice`);
    groups.add(mapping.adGroup);
  }

  // The staged approval.
  const aggregator = ofFunction('AGGREGATOR')[0];
  const workflow = workflowRuleParams(pack, aggregator === undefined ? new Map() : new Map([[aggregator.code, PROBE_UNIT_ID]]));
  if (pack.steps.length === 0) bad('STEPS', 'PACK', 'steps', 'the staged approval has its steps');
  for (const step of pack.steps) {
    const key = stepKey(step.id);
    if (!STEP_ID.test(step.id)) bad('STEP_ID', key, 'business_key', 'a step id is lower case letters, digits, - and _, 2 to 40 characters');
    if (!Number.isFinite(step.slaWorkingHours) || step.slaWorkingHours < 1 || step.slaWorkingHours > 720) bad('STEP_DEADLINE', key, 'data.sla_working_hours', 'every step has a deadline of 1 to 720 working hours');
    if (step.assignee === 'DOA' && step.kind !== 'UNIT_APPROVER') bad('STEP_ASSIGNEE', key, 'data.assignee', 'only the unit approver comes from the matrix of authority; the other steps name a role in the planning unit');
    if (step.assignee === 'ROLE_IN_UNIT') {
      if (step.roleCode !== planner?.code) bad('STEP_ROLE', key, 'data.role', 'the planning steps are held by the planning reviewer role');
      if (aggregator === undefined || step.unitCode !== aggregator.code) bad('STEP_UNIT', key, 'data.unit', 'the planning steps are held in the planning unit');
    }
  }
  const defect = reportWorkflowDefect(workflow);
  if (defect !== undefined) bad('STEP_CHAIN', 'PACK', 'steps', `the steps are not a chain the platform runs: ${defect}`);
  if (pack.steps[0]?.kind !== 'UNIT_APPROVER') bad('STEP_CHAIN', 'PACK', 'steps', 'the first step is the unit approver');

  // The absence policy and the matrix rule.
  try {
    absencePolicyOf(pack.absence);
  } catch (error) {
    bad('ABSENCE_POLICY', policyKey('ABSENCE'), error instanceof DomainError ? (error.detail ?? 'params') : 'params', 'the absence policy is not one the platform accepts');
  }
  if (pack.doa.documentType !== 'REPORT_ACCEPT') bad('DOA_DOCUMENT', doaKey(pack.doa.documentType), 'business_key', 'the matrix rule is for the document type REPORT_ACCEPT, the type the report approval resolves');
  if (pack.doa.roleCode !== approver?.code) bad('DOA_ROLE', doaKey(pack.doa.documentType), 'data.role', 'the matrix approver is the unit approver role');
  const root = roots[0];
  if (root === undefined || pack.doa.unitCode !== root.code) bad('DOA_UNIT', doaKey(pack.doa.documentType), 'data.unit', 'the matrix rule holds from the root and over its subtree');
  if (!Number.isInteger(pack.doa.approvalLevels) || pack.doa.approvalLevels < 1 || pack.doa.approvalLevels > 5) bad('DOA_LEVELS', doaKey(pack.doa.documentType), 'data.approval_levels', 'approval levels is a whole number from 1 to 5');
  if (REPORT_ACCEPT_BUSINESS_TYPE !== 'report.accept') bad('DOA_DOCUMENT', 'PACK', 'doa', 'the business type of the report approval changed');

  // Catalogue entries.
  const entryByKey = new Map<string, PackEntry>();
  for (const item of pack.entries) {
    const key = entryKey(item.masterType, item.key);
    if (!ENTRY_TYPE.test(item.masterType)) bad('ENTRY_TYPE', key, 'data.type', 'a master type is upper case words joined by _');
    if (!ENTRY_KEY.test(item.key)) bad('ENTRY_KEY', key, 'data.key', 'a catalogue key is letters, digits, . _ and -, up to 100 characters');
    if (item.label.trim().length < 1 || item.label.length > 200) bad('ENTRY_LABEL', key, 'name', 'an entry has a name of up to 200 characters');
    if (entryByKey.has(key)) bad('ENTRY_DUPLICATE', key, 'business_key', 'an entry is listed once');
    entryByKey.set(key, item);
  }
  for (const item of pack.entries) {
    const key = entryKey(item.masterType, item.key);
    let depth = 0;
    let at: PackEntry | undefined = item;
    const visited = new Set<string>();
    while (at?.parentKey !== undefined && at.parentKey !== null) {
      const parent: PackEntry | undefined = entryByKey.get(entryKey(at.masterType, at.parentKey));
      if (parent === undefined) {
        bad('ENTRY_PARENT', key, 'parent_key', 'the parent is an entry of the same type in the pack');
        break;
      }
      if (visited.has(at.key)) {
        bad('ENTRY_CYCLE', key, 'parent_key', 'the entries form a cycle');
        break;
      }
      visited.add(at.key);
      at = parent;
      depth += 1;
    }
    if (depth >= MAX_ENTRY_DEPTH) bad('ENTRY_DEPTH', key, 'parent_key', `a catalogue tree is at most ${MAX_ENTRY_DEPTH} levels`);
  }
  return defects;
}

/** The judgement of rows: the defects of the rows, then the defects of the pack that the rows make. */
export function judgeOrgPackRows(rows: readonly PackRow[]): PackDefect[] {
  const { pack, defects } = orgPackOfRows(rows);
  return [...defects, ...judgeOrgPack(pack)];
}

/** The mapping the batch judge uses for the pack file: the generic row rules, then the rules of the pack, each defect reported on its row. */
export const ORG_PACK_MAPPING: MigrationMapping = {
  version: ORG_PACK_MAPPING_VERSION,
  businessKeyColumn: 'business_key',
  amountColumn: null,
  requiredColumns: ['business_key', 'kind', 'pack'],
  references: [],
  check: (rows: readonly JudgedRow[]): RowError[] => {
    const byKey = new Map(rows.map((row) => [row.businessKey, row]));
    const first = rows[0];
    const errors: RowError[] = [];
    for (const defect of judgeOrgPackRows(rows.map((row) => ({ rowNumber: row.rowNumber, businessKey: row.businessKey, payload: row.payload })))) {
      const at = byKey.get(defect.key) ?? first;
      if (at === undefined) continue;
      errors.push({ rowNumber: at.rowNumber, lineNumber: at.lineNumber, field: defect.field, code: 'PACK_INVALID', message: `${defect.code}: ${defect.message}` });
    }
    return errors;
  },
};

// -- Rule data the pack becomes -------------------------------------------------------------------------------------------------------------------------------------------------------

/** The params of the governance rule `APPROVAL_WORKFLOW_DEFINITION` / `REPORT_ACCEPT` for the pack: the chain of the staged mode, the planning steps held by the planning role in the planning unit. */
export function workflowRuleParams(pack: Pick<OrgPack, 'steps'>, unitIdOfCode: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    mode: 'STAGED',
    steps: pack.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      name: step.name,
      assignee_type: step.assignee,
      ...(step.assignee === 'ROLE_IN_UNIT' ? { role_code: step.roleCode ?? '', unit_id: unitIdOfCode.get(step.unitCode ?? '') ?? '' } : {}),
      min_approvals: 1,
      sla_working_hours: step.slaWorkingHours,
      on_timeout: step.onTimeout,
    })),
  };
}

/** The rule of the matrix of authority for the pack: the unit approver of the unit the report belongs to, over the whole tree. */
export function doaRuleContent(pack: Pick<OrgPack, 'doa'>, unitId: string, roleId: string): DoaRuleContent {
  return {
    document_type: pack.doa.documentType,
    unit_id: unitId,
    include_subtree: true,
    amount_min_vnd: '0',
    amount_max_vnd: null,
    approver_role_id: roleId,
    approval_levels: pack.doa.approvalLevels,
    requires_distinct_approvers: true,
  };
}

export const isUuid = (value: string): boolean => UUID.test(value);

// -- Plan and verification -----------------------------------------------------------------------------------------------------------------------------------------------------------------

export type PlanAction = 'CREATE' | 'UNCHANGED' | 'PENDING' | 'DRIFT' | 'BLOCKED';
export type PlanSection = 'UNIT' | 'ROLE' | 'WORKFLOW' | 'ABSENCE' | 'DOA' | 'ENTRY';

export interface PlanItem {
  section: PlanSection;
  key: string;
  action: PlanAction;
  /** What differs or what blocks, in words for the report; empty when nothing does. */
  detail: string;
}

/** What the tenant has now, read by the store. A rule or an entry that waits for approval is `PENDING`, not absent. */
export interface OrgPackState {
  units: ReadonlyMap<string, { id: string; name: string; parentCode: string | null; active: boolean }>;
  roles: ReadonlyMap<string, { id: string; name: string; rank: number; permissions: readonly string[]; active: boolean }>;
  /** Versions of the rule `REPORT_ACCEPT` as the store read them, newest first; the pending ones are DRAFT or SUBMITTED, the live ones APPROVED. */
  workflowVersions: ReadonlyArray<{ status: string; params: unknown }>;
  absenceVersions: ReadonlyArray<{ status: string; params: unknown }>;
  /** The state of the matrix rule: `PRESENT` when the published matrix has the rule for the document type, `OTHER_APPROVER` when it has it with another approver, `PENDING` when a draft or a pending matrix carries it, `NONE`. */
  doa: 'PRESENT' | 'OTHER_APPROVER' | 'PENDING' | 'NONE';
  /** Entries by `TYPE:key`: the label, the key of the parent and the status of the record. */
  entries: ReadonlyMap<string, { label: string; parentKey: string | null; status: string }>;
  /** The number of active holders of each seat, by `ROLE@UNIT`. */
  holders: ReadonlyMap<string, number>;
  /** Active grants of the roles of the pack that sit in no seat: a role held with a scope or in a unit the pack does not give it. */
  strayGrants?: number;
}

const PENDING_RULE = ['DRAFT', 'SUBMITTED'];
const LIVE_RULE = ['APPROVED'];
const sameParams = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

function planRule(section: 'WORKFLOW' | 'ABSENCE', key: string, wanted: unknown, versions: OrgPackState['workflowVersions']): PlanItem {
  const live = versions.find((version) => LIVE_RULE.includes(version.status));
  if (live !== undefined && sameParams(live.params, wanted)) return { section, key, action: 'UNCHANGED', detail: '' };
  if (versions.some((version) => PENDING_RULE.includes(version.status) && sameParams(version.params, wanted))) return { section, key, action: 'PENDING', detail: 'a version with these params waits for approval' };
  if (live !== undefined) return { section, key, action: 'DRIFT', detail: 'another version is in force; a new version needs its own approval' };
  return { section, key, action: 'CREATE', detail: '' };
}

/** What a materialisation would do (or did): one item for each object of the pack, never an overwrite. */
export function planOrgPack(pack: OrgPack, state: OrgPackState): PlanItem[] {
  const items: PlanItem[] = [];
  for (const unit of pack.units) {
    const key = unitKey(unit.code);
    const have = state.units.get(unit.code);
    // The root of the organisation is the root the tenant was provisioned with: it is adopted under whatever name and code it has, never renamed or created.
    if (unit.parentCode === null) items.push(have === undefined ? { section: 'UNIT', key, action: 'BLOCKED', detail: 'the tenant has no root unit' } : { section: 'UNIT', key, action: 'UNCHANGED', detail: '' });
    else if (have === undefined) items.push({ section: 'UNIT', key, action: 'CREATE', detail: '' });
    else if (!have.active) items.push({ section: 'UNIT', key, action: 'BLOCKED', detail: 'the unit exists but is not active' });
    else if (have.name !== unit.name || have.parentCode !== unit.parentCode) items.push({ section: 'UNIT', key, action: 'DRIFT', detail: have.name !== unit.name ? 'the name differs' : 'the parent differs' });
    else items.push({ section: 'UNIT', key, action: 'UNCHANGED', detail: '' });
  }
  for (const role of pack.roles) {
    const key = roleKey(role.code);
    const have = state.roles.get(role.code);
    if (have === undefined) items.push({ section: 'ROLE', key, action: 'CREATE', detail: '' });
    else if (!have.active) items.push({ section: 'ROLE', key, action: 'BLOCKED', detail: 'the role exists but is not active' });
    else if (have.rank !== role.rank || have.permissions.length !== role.permissions.length || ![...role.permissions].every((name) => have.permissions.includes(name))) {
      items.push({ section: 'ROLE', key, action: 'DRIFT', detail: have.rank !== role.rank ? 'the rank differs' : 'the permissions differ' });
    } else items.push({ section: 'ROLE', key, action: 'UNCHANGED', detail: '' });
  }
  const unitIds = new Map([...state.units].map(([code, unit]) => [code, unit.id]));
  const planningReady = pack.units.every((unit) => state.units.has(unit.code));
  const wantedWorkflow = workflowRuleParams(pack, unitIds);
  items.push(
    planningReady || state.workflowVersions.length > 0
      ? planRule('WORKFLOW', 'RULE:APPROVAL_WORKFLOW_DEFINITION:REPORT_ACCEPT', wantedWorkflow, state.workflowVersions)
      : { section: 'WORKFLOW', key: 'RULE:APPROVAL_WORKFLOW_DEFINITION:REPORT_ACCEPT', action: 'CREATE', detail: 'written once the planning unit exists' },
  );
  items.push(planRule('ABSENCE', 'RULE:ABSENCE_POLICY:DEFAULT', pack.absence, state.absenceVersions));
  const doa = doaKey(pack.doa.documentType);
  items.push(
    state.doa === 'PRESENT'
      ? { section: 'DOA', key: doa, action: 'UNCHANGED', detail: '' }
      : state.doa === 'PENDING'
        ? { section: 'DOA', key: doa, action: 'PENDING', detail: 'a matrix with the rule waits for approval' }
        : state.doa === 'OTHER_APPROVER'
          ? { section: 'DOA', key: doa, action: 'DRIFT', detail: 'the published matrix names another approver for this document type' }
          : { section: 'DOA', key: doa, action: 'CREATE', detail: '' },
  );
  for (const item of pack.entries) {
    const key = entryKey(item.masterType, item.key);
    const have = state.entries.get(`${item.masterType}:${item.key}`);
    if (have === undefined) items.push({ section: 'ENTRY', key, action: 'CREATE', detail: '' });
    else if (['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(have.status)) items.push({ section: 'ENTRY', key, action: 'PENDING', detail: 'the entry waits for review or publication' });
    else if (have.status === 'RETIRED') items.push({ section: 'ENTRY', key, action: 'BLOCKED', detail: 'the entry was retired' });
    else if (have.label !== item.label || have.parentKey !== item.parentKey) items.push({ section: 'ENTRY', key, action: 'DRIFT', detail: have.label !== item.label ? 'the name differs' : 'the parent differs' });
    else items.push({ section: 'ENTRY', key, action: 'UNCHANGED', detail: '' });
  }
  return items;
}

export type SeatState = 'VACANT' | 'FILLED' | 'OVER';
export interface SeatReport {
  key: string;
  adGroup: string;
  roleCode: string;
  unitCode: string;
  scope: SeatScope;
  holders: number;
  min: number;
  max: number;
  state: SeatState;
}

/** How full each seat is: a seat below its minimum is vacant (nobody does the work), above its maximum is over (more people than the agreement allows). */
export function seatReports(pack: OrgPack, state: Pick<OrgPackState, 'holders'>): SeatReport[] {
  const roles = new Map(pack.roles.map((role) => [role.code, role]));
  return pack.seats.map((seat) => {
    const holders = state.holders.get(`${seat.roleCode}@${seat.unitCode}`) ?? 0;
    const role = roles.get(seat.roleCode);
    return {
      key: seatKey(seat.roleCode, seat.unitCode),
      adGroup: role === undefined ? '' : directoryGroupOf(pack, role, seat.unitCode),
      roleCode: seat.roleCode,
      unitCode: seat.unitCode,
      scope: seat.scope,
      holders,
      min: seat.minHolders,
      max: seat.maxHolders,
      state: holders < seat.minHolders ? 'VACANT' : holders > seat.maxHolders ? 'OVER' : 'FILLED',
    };
  });
}

export interface OrgPackVerification {
  label: string;
  digest: string;
  items: PlanItem[];
  seats: SeatReport[];
  counts: Record<PlanAction, number>;
  seatCounts: Record<SeatState, number>;
  /** Grants of the roles of the pack outside every seat: wider or elsewhere than the pack says. */
  strayGrants: number;
  /** True when every object stands as the pack says (nothing to create, no drift, nothing blocked); a pending approval does not make it false but is counted. */
  structureComplete: boolean;
}

/** The verification report: the plan against the state, and the seats against their holders. */
export function verifyOrgPack(pack: OrgPack, state: OrgPackState): OrgPackVerification {
  const items = planOrgPack(pack, state);
  const seats = seatReports(pack, state);
  const counts: Record<PlanAction, number> = { CREATE: 0, UNCHANGED: 0, PENDING: 0, DRIFT: 0, BLOCKED: 0 };
  for (const item of items) counts[item.action] += 1;
  const seatCounts: Record<SeatState, number> = { VACANT: 0, FILLED: 0, OVER: 0 };
  for (const seat of seats) seatCounts[seat.state] += 1;
  return { label: pack.label, digest: orgPackDigest(pack), items, seats, counts, seatCounts, strayGrants: state.strayGrants ?? 0, structureComplete: counts.CREATE === 0 && counts.DRIFT === 0 && counts.BLOCKED === 0 };
}
