import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';

/**
 * The data contracts of DGV (ST-DGV-005, DGV 3.1 F2, BR-DGV-07): a contract is an ODCS document (Open Data Contract Standard) of the version the platform pins. The document is checked against the part of the pinned
 * schema the platform reads, its columns are put in one shape that two revisions can be compared in, and the change from the published revision to the new one is classified: a breaking change needs every registered
 * consumer to approve and a window in which both revisions are served.
 */

/** The ODCS versions the platform accepts: the pin is the 3.0 line, and a document names the version it was written for. */
export const ODCS_VERSIONS = ['v3.0.0', 'v3.0.1', 'v3.0.2'] as const;
export type OdcsVersion = (typeof ODCS_VERSIONS)[number];
export const ODCS_PINNED: OdcsVersion = 'v3.0.2';

/** The logical types of ODCS 3.0. */
export const ODCS_LOGICAL_TYPES = ['string', 'date', 'number', 'integer', 'object', 'array', 'boolean'] as const;

/** How many days the window of a breaking change lasts at least after the day the revision takes effect (BR-DGV-07, an assumption to be confirmed). */
export const CONTRACT_MIGRATION_DAYS = 30;

export const CONSUMER_KINDS = ['MODULE', 'BI_DATASET', 'EXPORT', 'EXTERNAL'] as const;
export type ConsumerKind = (typeof CONSUMER_KINDS)[number];

export const CONTRACT_COMPATIBILITY = ['INITIAL', 'BACKWARD_COMPATIBLE', 'BREAKING'] as const;
export type Compatibility = (typeof CONTRACT_COMPATIBILITY)[number];

/** The classifications a column can be given, from the lowest to the highest (a change to a higher one is breaking). */
const CLASSIFICATION_ORDER: readonly string[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'];

/** A column of the contract in the shape two revisions are compared in. */
export interface ContractColumn {
  object: string;
  name: string;
  logicalType: string;
  physicalType: string | null;
  required: boolean;
  primaryKey: boolean;
  classification: string | null;
  unit: string | null;
}

/** A consumer the contract declares: who reads the data and the person who answers for that. */
export interface ContractConsumer {
  kind: ConsumerKind;
  ref: string;
  ownerUserId: string;
}

export interface ParsedContract {
  columns: ContractColumn[];
  consumers: ContractConsumer[];
  quality: unknown[];
  freshnessSeconds: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 200;
const MAX_OBJECTS = 100;
const MAX_PROPERTIES = 1000;
const MAX_CONSUMERS = 100;
const MAX_DEPTH = 8;
const FRESHNESS_UNITS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** A name as a part of the path of a column: the characters that join the parts are escaped, so that a field `b` of `a` and a column named `a.b` are not the same column. */
const segment = (name: string): string => name.replace(/[\\.[\]]/g, '\\$&');

const invalid = (path: string): DomainError => new DomainError('ODCS_SCHEMA_INVALID', 422, path);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT || value.includes('\0')) throw invalid(path);
  return value;
};
const optionalText = (value: unknown, path: string): string | null => (value === undefined || value === null ? null : text(value, path));

/** The value of a custom property of an ODCS element (`customProperties` is a list of `{ property, value }`). */
function customProperty(element: Record<string, unknown>, property: string, path: string): unknown {
  const list = element.customProperties;
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw invalid(`${path}.customProperties`);
  for (const [index, item] of list.entries()) if (!isRecord(item) || typeof item.property !== 'string') throw invalid(`${path}.customProperties[${index}]`);
  return (list as Array<Record<string, unknown>>).find((item) => item.property === property)?.value;
}

function consumersOf(root: Record<string, unknown>): ContractConsumer[] {
  const list = root.customProperties;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw invalid('customProperties');
  const found = new Map<string, ContractConsumer>();
  for (const [index, item] of list.entries()) {
    const path = `customProperties[${index}]`;
    if (!isRecord(item) || typeof item.property !== 'string') throw invalid(path);
    if (item.property !== 'consumer') continue;
    const value = item.value;
    if (!isRecord(value)) throw invalid(`${path}.value`);
    const kind = CONSUMER_KINDS.find((candidate) => candidate === value.kind);
    if (kind === undefined) throw invalid(`${path}.value.kind`);
    const ref = text(value.ref, `${path}.value.ref`);
    if (typeof value.owner_user_id !== 'string' || !UUID.test(value.owner_user_id)) throw invalid(`${path}.value.owner_user_id`);
    found.set(`${kind}:${ref}`, { kind, ref, ownerUserId: value.owner_user_id.toLowerCase() });
    if (found.size > MAX_CONSUMERS) throw invalid('customProperties');
  }
  return [...found.values()];
}

function freshnessOf(root: Record<string, unknown>): number | null {
  const list = root.slaProperties;
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw invalid('slaProperties');
  for (const [index, item] of list.entries()) {
    const path = `slaProperties[${index}]`;
    if (!isRecord(item) || typeof item.property !== 'string') throw invalid(path);
    if (item.property !== 'freshness') continue;
    const unit = typeof item.unit === 'string' ? FRESHNESS_UNITS[item.unit] : undefined;
    if (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value <= 0 || unit === undefined) throw invalid(`${path}.value`);
    // The seconds are what is stored: less than one second, or more than a number can hold exactly, is not a freshness.
    const seconds = Math.round(item.value * unit);
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw invalid(`${path}.value`);
    return seconds;
  }
  return null;
}

/**
 * Reads an ODCS document of the version the revision names: the fields the platform stands on are checked (the identity of the contract, the objects with their columns, the types, the consumers and the freshness it
 * declares) and anything wrong is ODCS_SCHEMA_INVALID naming the path. What the platform does not read (the fields the standard lets a contract carry) is kept in the document and not judged.
 */
export function parseOdcs(raw: unknown, declaredVersion: string): ParsedContract {
  if (!ODCS_VERSIONS.includes(declaredVersion as OdcsVersion)) throw new DomainError('ODCS_SCHEMA_INVALID', 422, 'odcs_version');
  if (!isRecord(raw)) throw invalid('odcs_json');
  if (raw.apiVersion !== declaredVersion) throw invalid('apiVersion');
  if (raw.kind !== 'DataContract') throw invalid('kind');
  text(raw.id, 'id');
  text(raw.version, 'version');
  text(raw.status, 'status');
  if (!Array.isArray(raw.schema) || raw.schema.length === 0 || raw.schema.length > MAX_OBJECTS) throw invalid('schema');
  const columns: ContractColumn[] = [];
  const objects = new Set<string>();
  for (const [objectIndex, object] of raw.schema.entries()) {
    const objectPath = `schema[${objectIndex}]`;
    if (!isRecord(object)) throw invalid(objectPath);
    const objectName = text(object.name, `${objectPath}.name`);
    if (objects.has(objectName)) throw invalid(`${objectPath}.name`);
    objects.add(objectName);
    if (!Array.isArray(object.properties) || object.properties.length === 0) throw invalid(`${objectPath}.properties`);
    const names = new Set<string>();
    // A column inside another (the fields of an object, the element of an array) is a column of its own, named by its path: a change inside it is a change of the contract like any other.
    const add = (property: Record<string, unknown>, path: string, name: string, depth: number): void => {
      if (names.has(name)) throw invalid(`${path}.name`);
      names.add(name);
      const logicalType = ODCS_LOGICAL_TYPES.find((candidate) => candidate === property.logicalType);
      if (logicalType === undefined) throw invalid(`${path}.logicalType`);
      if (property.required !== undefined && typeof property.required !== 'boolean') throw invalid(`${path}.required`);
      if (property.primaryKey !== undefined && typeof property.primaryKey !== 'boolean') throw invalid(`${path}.primaryKey`);
      const classification = optionalText(property.classification, `${path}.classification`);
      // A classification the platform does not rank would count as less sensitive than every other one.
      if (classification !== null && !CLASSIFICATION_ORDER.includes(classification.toUpperCase())) throw invalid(`${path}.classification`);
      const unit = customProperty(property, 'unit', path);
      if (unit !== undefined && typeof unit !== 'string') throw invalid(`${path}.customProperties`);
      columns.push({
        object: objectName,
        name,
        logicalType,
        physicalType: optionalText(property.physicalType, `${path}.physicalType`),
        required: property.required === true,
        primaryKey: property.primaryKey === true,
        classification: classification === null ? null : classification.toUpperCase(),
        unit: unit === undefined ? null : unit,
      });
      if (columns.length > MAX_PROPERTIES) throw invalid('schema');
      if (property.properties !== undefined) {
        if (!Array.isArray(property.properties) || depth >= MAX_DEPTH) throw invalid(`${path}.properties`);
        for (const [childIndex, child] of property.properties.entries()) {
          const childPath = `${path}.properties[${childIndex}]`;
          if (!isRecord(child)) throw invalid(childPath);
          add(child, childPath, `${name}.${segment(text(child.name, `${childPath}.name`))}`, depth + 1);
        }
      }
      if (property.items !== undefined) {
        if (!isRecord(property.items) || depth >= MAX_DEPTH) throw invalid(`${path}.items`);
        add(property.items, `${path}.items`, `${name}[]`, depth + 1);
      }
    };
    for (const [propertyIndex, property] of object.properties.entries()) {
      const path = `${objectPath}.properties[${propertyIndex}]`;
      if (!isRecord(property)) throw invalid(path);
      add(property, path, segment(text(property.name, `${path}.name`)), 0);
    }
  }
  if (raw.quality !== undefined && !Array.isArray(raw.quality)) throw invalid('quality');
  columns.sort((a, b) => a.object.localeCompare(b.object) || a.name.localeCompare(b.name));
  return { columns, consumers: consumersOf(raw), quality: (raw.quality as unknown[] | undefined) ?? [], freshnessSeconds: freshnessOf(raw) };
}

/** The hash of a document: the same document is the same hash whatever the order of its keys. */
export const odcsSha256 = (odcs: unknown): string => sha256Hex(canonicalJson(odcs));

export interface ContractChange {
  kind:
    | 'COLUMN_REMOVED'
    | 'COLUMN_ADDED_REQUIRED'
    | 'COLUMN_ADDED_OPTIONAL'
    | 'TYPE_CHANGED'
    | 'MADE_REQUIRED'
    | 'MADE_OPTIONAL'
    | 'GRAIN_CHANGED'
    | 'UNIT_CHANGED'
    | 'CLASSIFICATION_RAISED'
    | 'CLASSIFICATION_LOWERED';
  object: string;
  column: string;
  breaking: boolean;
}

const PHYSICAL = /^\s*([a-z][a-z0-9_ ]*?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/i;

/** How many decimal digits the integer types hold at most (a type that is not here is not known to be an integer type). */
const INTEGER_DIGITS: Readonly<Record<string, number>> = { smallint: 5, int2: 5, integer: 10, int: 10, int4: 10, bigint: 19, int8: 19 };
const baseOf = (physical: string): string | undefined => PHYSICAL.exec(physical)?.[1]?.toLowerCase();

/**
 * Whether the new physical type holds everything the old one held. The same type holds it when its scale is the same and its precision or length is not smaller; an integer type is held by a wider integer type and by a
 * numeric type with room for its digits to the left of the point. Anything else cannot be shown to hold it, and is taken as a change of type.
 */
function holds(before: string, after: string): boolean {
  if (before.trim().toLowerCase() === after.trim().toLowerCase()) return true;
  const a = PHYSICAL.exec(before);
  const b = PHYSICAL.exec(after);
  if (a === null || b === null) return false;
  if (a[1]?.toLowerCase() === b[1]?.toLowerCase()) return a[2] !== undefined && b[2] !== undefined && Number(b[2]) >= Number(a[2]) && Number(b[3] ?? 0) === Number(a[3] ?? 0);
  const digits = INTEGER_DIGITS[baseOf(before) ?? ''];
  if (digits === undefined) return false;
  const wider = INTEGER_DIGITS[baseOf(after) ?? ''];
  if (wider !== undefined) return wider >= digits;
  const target = baseOf(after);
  if (target !== 'numeric' && target !== 'decimal') return false;
  return b[2] === undefined || Number(b[2]) - Number(b[3] ?? 0) >= digits;
}

function typeChanged(before: ContractColumn, after: ContractColumn): boolean {
  if (before.logicalType !== after.logicalType && !(before.logicalType === 'integer' && after.logicalType === 'number')) return true;
  if (before.physicalType === null || after.physicalType === null) return before.physicalType !== after.physicalType && before.physicalType !== null;
  return !holds(before.physicalType, after.physicalType);
}

/**
 * The change from the published revision to a new one (BR-DGV-07). A column that is removed (or renamed: a name that is gone), a type that is not widened, a column that becomes required (or is added as required), a
 * change of the key that gives the grain, of the unit or the currency, and a classification that is raised are breaking; a column added as optional, a column relaxed to optional, a classification lowered and any
 * change outside the columns are backward compatible. The first revision has nothing to be compared with.
 */
export function classifyChange(previous: readonly ContractColumn[] | undefined, next: readonly ContractColumn[]): { compatibility: Compatibility; changes: ContractChange[] } {
  if (previous === undefined) return { compatibility: 'INITIAL', changes: [] };
  const changes: ContractChange[] = [];
  // The object and the name are texts without NUL; a list of the two cannot be taken for another pair.
  const key = (column: ContractColumn): string => JSON.stringify([column.object, column.name]);
  const now = new Map(next.map((column) => [key(column), column]));
  const before = new Map(previous.map((column) => [key(column), column]));
  for (const old of previous) {
    const column = now.get(key(old));
    if (column === undefined) {
      changes.push({ kind: 'COLUMN_REMOVED', object: old.object, column: old.name, breaking: true });
      continue;
    }
    if (typeChanged(old, column)) changes.push({ kind: 'TYPE_CHANGED', object: old.object, column: old.name, breaking: true });
    if (!old.required && column.required) changes.push({ kind: 'MADE_REQUIRED', object: old.object, column: old.name, breaking: true });
    if (old.required && !column.required) changes.push({ kind: 'MADE_OPTIONAL', object: old.object, column: old.name, breaking: false });
    if (old.primaryKey !== column.primaryKey) changes.push({ kind: 'GRAIN_CHANGED', object: old.object, column: old.name, breaking: true });
    if (old.unit !== column.unit) changes.push({ kind: 'UNIT_CHANGED', object: old.object, column: old.name, breaking: true });
    const from = old.classification === null ? -1 : CLASSIFICATION_ORDER.indexOf(old.classification);
    const to = column.classification === null ? -1 : CLASSIFICATION_ORDER.indexOf(column.classification);
    if (to > from) changes.push({ kind: 'CLASSIFICATION_RAISED', object: old.object, column: old.name, breaking: true });
    else if (to < from) changes.push({ kind: 'CLASSIFICATION_LOWERED', object: old.object, column: old.name, breaking: false });
  }
  for (const column of next) {
    // A column added to the key changes the grain, required or not.
    if (!before.has(key(column)))
      changes.push({
        kind: column.primaryKey ? 'GRAIN_CHANGED' : column.required ? 'COLUMN_ADDED_REQUIRED' : 'COLUMN_ADDED_OPTIONAL',
        object: column.object,
        column: column.name,
        breaking: column.required || column.primaryKey,
      });
  }
  return { compatibility: changes.some((change) => change.breaking) ? 'BREAKING' : 'BACKWARD_COMPATIBLE', changes };
}

/** The first day a window may end for a revision that takes effect on `effectiveFrom` (dates as YYYY-MM-DD). */
export function earliestMigrationEnd(effectiveFrom: string): string {
  const date = new Date(`${effectiveFrom}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + CONTRACT_MIGRATION_DAYS);
  return date.toISOString().slice(0, 10);
}

/** Whether a breaking revision has the window it needs: it ends at least thirty days after the revision takes effect. */
export const migrationWindowEnough = (effectiveFrom: string, until: string): boolean => until >= earliestMigrationEnd(effectiveFrom);

/**
 * The consumers a revision must be approved by: those the platform knows of (BI datasets built on the dataset) and those the published contract declares, once each. When both name the same consumer the platform knows
 * who answers for it, and a declaration cannot name somebody else.
 */
export function requiredConsumers(declared: readonly ContractConsumer[], known: readonly ContractConsumer[]): ContractConsumer[] {
  const found = new Map<string, ContractConsumer>();
  for (const consumer of [...known, ...declared]) {
    const key = `${consumer.kind}:${consumer.ref}`;
    if (!found.has(key)) found.set(key, consumer);
  }
  return [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
}
