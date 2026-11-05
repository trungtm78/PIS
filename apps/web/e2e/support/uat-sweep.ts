import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the operation sweep of the isolation UAT needs (apps/web/e2e/uat/isolation-api.uat.spec.ts): the operations of the design
 * (Design/MACHVON_Design/03_Engineering/openapi.json) that name an object by an id in their path, the ones the API of the stack
 * implements, and a request for each that is valid by the schema of the design (a command whose body is refused before its lookup
 * proves nothing about tenancy). Pure functions over the document: no network, no database.
 */

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  enum?: unknown[];
  pattern?: string;
  format?: string;
  contentEncoding?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: OpenApiSchema;
  $ref?: string;
}

interface OpenApiOperationObject {
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
  'x-plane'?: string;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, OpenApiSchema>; parameters?: Record<string, OpenApiParameter> };
}

export interface PathSlot {
  /** The name of the path parameter, such as `id` or `conversationId`. */
  name: string;
  /** The path segment right before it (`/projects/{id}` gives `projects`), which tells what kind of object the id names. */
  segment: string;
}

export interface SweepOperation {
  operationId: string;
  method: string;
  path: string;
  /** `tenant` for the operations a tenant member may call; the others (`control`, `internal`, `edge`) refuse a tenant token. */
  plane: string;
  slots: PathSlot[];
  query: Array<{ name: string; value: string }>;
  /** A body that is valid by the schema of the design, or undefined when the operation takes none. */
  body: unknown;
  versioned: boolean;
}

export interface SkippedOperation {
  operationId: string;
  method: string;
  path: string;
  reason: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const PATH_PARAMETER = /\{([^{}/]+)\}/g;
const ID_NAME = /^(id|[a-z][A-Za-z0-9]*Id|[a-z_]+_id)$/;
const MAX_DEPTH = 12;
const FUTURE_NAME = /^(due|planned|scheduled)|effective_date/;
const PATTERN_GUESSES = ['1', '0', 'a', 'A', 'A1', 'a1', 'vi', 'VN', 'VND', '1000', '2026', '2026-01', '2026-06-15', 'abc', 'ABC-001', 'ABC_001', 'x@example.test', '+84900000000', '0100000001', '1.0.0', 'v1', '2026-06-15T03:00:00Z', '#aabbcc', 'uat.example.test', 'a'.repeat(64)];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The operationIds that a controller of the API declares with `@OperationId('…')`: what the API implements. */
export function implementedOperationIds(sourceDirectory: string): Set<string> {
  const found = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/@OperationId\('([^']+)'\)/g)) found.add(match[1] ?? '');
      }
    }
  };
  visit(sourceDirectory);
  return found;
}

function resolveRef(document: OpenApiDocument, schema: OpenApiSchema): OpenApiSchema {
  let current = schema;
  for (let hops = 0; current.$ref !== undefined && hops < MAX_DEPTH; hops += 1) {
    const name = current.$ref.split('/').pop() ?? '';
    const target = document.components?.schemas?.[name];
    if (target === undefined) throw new Error(`schema ${name} is not in the document`);
    current = target;
  }
  return current;
}

function stringFor(schema: OpenApiSchema, name: string): string {
  const min = schema.minLength ?? 0;
  const max = schema.maxLength ?? Number.MAX_SAFE_INTEGER;
  const fits = (value: string): boolean => value.length >= min && value.length <= max;
  switch (schema.format) {
    case 'uuid':
      return randomUUID();
    // What is planned, scheduled or due is in the future; what happened (a filing, a record, an occurrence) is past: the commands refuse the other way round.
    case 'date':
      return FUTURE_NAME.test(name) ? '2031-06-15' : '2026-06-15';
    case 'date-time':
      return FUTURE_NAME.test(name) ? '2031-06-15T03:00:00Z' : '2026-06-15T03:00:00Z';
    case 'email':
      return 'uat@example.test';
    case 'uri':
      return 'https://example.test/uat';
    default:
      break;
  }
  if (schema.contentEncoding === 'base64') return 'QUFBQQ==';
  if (schema.pattern !== undefined) {
    const pattern = new RegExp(schema.pattern);
    const guess = PATTERN_GUESSES.find((candidate) => pattern.test(candidate) && fits(candidate));
    if (guess !== undefined) return guess;
    throw new Error(`no value for the pattern ${schema.pattern}`);
  }
  // Long enough for the rules that ask a reason of 20 characters.
  let value = 'A text of the UAT sweep';
  while (value.length < min) value += 'x';
  return value.length > max ? value.slice(0, max) : value;
}

/** An instance of the schema with every required property and nothing else: the smallest body the contract accepts. */
export function instanceOf(document: OpenApiDocument, source: OpenApiSchema, depth = 0, name = ''): unknown {
  if (depth > MAX_DEPTH) throw new Error('schema is too deep');
  const schema = resolveRef(document, source);
  if (schema.enum !== undefined) return schema.enum[0];
  const alternative = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alternative !== undefined) return instanceOf(document, alternative, depth + 1, name);
  if (schema.allOf !== undefined) {
    const parts = schema.allOf.map((part) => instanceOf(document, part, depth + 1));
    return Object.assign({}, ...parts.filter(isObject));
  }
  const type = Array.isArray(schema.type) ? (schema.type.find((candidate) => candidate !== 'null') ?? 'null') : schema.type;
  switch (type) {
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const name of schema.required ?? []) {
        const property = schema.properties?.[name];
        result[name] = property === undefined ? 'uat-value' : instanceOf(document, property, depth + 1, name);
      }
      // A field the design says is required by the command (and the schema leaves optional) is given too.
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (result[name] === undefined && /(?<!not )(?<!never )\brequired\b|bắt buộc/i.test(property.description ?? '')) result[name] = instanceOf(document, property, depth + 1, name);
      }
      return result;
    }
    case 'array': {
      const count = Math.max(schema.minItems ?? 0, 1);
      return Array.from({ length: count }, () => (schema.items === undefined ? 'uat-value' : instanceOf(document, schema.items, depth + 1, name)));
    }
    case 'integer':
    case 'number': {
      const low = schema.minimum ?? 1;
      const value = low < 1 && (schema.maximum ?? 1) >= 1 ? 1 : low;
      return schema.maximum !== undefined && value > schema.maximum ? schema.maximum : value;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return stringFor(schema, name);
  }
}

function withPatch(operationId: string, body: unknown): unknown {
  const patch = BODY_PATCHES[operationId];
  return patch !== undefined && isObject(body) ? { ...body, ...patch } : body;
}

function parameterOf(document: OpenApiDocument, parameter: OpenApiParameter): OpenApiParameter {
  if (parameter.$ref === undefined) return parameter;
  return document.components?.parameters?.[parameter.$ref.split('/').pop() ?? ''] ?? parameter;
}

function slotsOf(path: string): PathSlot[] {
  const slots: PathSlot[] = [];
  const segments = path.split('/');
  segments.forEach((segment, index) => {
    const match = /^\{([^{}]+)\}$/.exec(segment);
    if (match !== null) slots.push({ name: match[1] ?? '', segment: segments[index - 1] ?? '' });
  });
  return slots;
}

/**
 * Fields that a command asks for by a rule the schema does not state (a reason of a length, a date in the future, a phone number, a code of the
 * tenant): they are merged into the body generated from the schema, so that the request reaches the lookup of the object it names.
 */
export const BODY_PATCHES: Readonly<Record<string, Record<string, unknown>>> = {
  addContactIdentity: { external_id: '+84900000001' },
  addTaskForceMember: { member_role: 'MEMBER' },
  declareConflictOfInterest: { relation_text: 'A relation declared by the UAT sweep' },
  draftCapitalAllocation: { lines: [{ project_id: '00000000-0000-4000-8000-000000000a01', appropriation_id: '00000000-0000-4000-8000-000000000a02', bucket: 'CURRENT_YEAR', source_year: 2026, amount_vnd: '1' }] },
  recordProcurementMilestone: { planned_at: '2031-06-15T03:00:00Z' },
  replaceContractParties: {
    parties: [
      { contractor_id: '00000000-0000-4000-8000-000000000a03', role: 'LEAD', share_pct: '60', work_value_vnd: '600' },
      { contractor_id: '00000000-0000-4000-8000-000000000a04', role: 'MEMBER', share_pct: '40', work_value_vnd: '400' },
    ],
  },
  buildBiDatasetVersion: { as_of_period: '2026-01' },
  resolveProcurementPetition: { resolution_document_id: '00000000-0000-4000-8000-000000000a05' },
  reversePayment: { reason: 'Reversed by the UAT sweep' },
  requestProjectTransfer: { effective_date: '2031-06-15' },
  scheduleInspection: { scheduled_at: '2031-06-15T03:00:00Z' },
  resolveReconciliationItem: { note: 'Explained by the UAT sweep' },
  setChannelLimits: { daily_send_cap: 10 },
  sendConversationMessage: { text: 'A message of the UAT sweep' },
  submitCampaign: { preview_hash: 'a'.repeat(64) },
  updateChannelAccount: { display_name: 'A channel of the UAT sweep' },
  updateCannedReply: { channels: ['EMAIL'] },
  updateCustomRole: { permissions: ['project.read'] },
  verifyContactIdentity: { otp: '123456' },
  correctSiteDiary: { content: { weather_code: 'SUNNY', workforce_count: 3 } },
  reviseSiteDiaryDraft: { content: { weather_code: 'SUNNY', workforce_count: 3 } },
  post_reports_id_corrections: { amendment_reason: 'A correction of the UAT sweep, long enough' },
};

/** Query parameters a command asks for by a rule the schema does not state. */
export const QUERY_PATCHES: Readonly<Record<string, Record<string, string>>> = {
  downloadTenantExportFile: { path: 'manifest.json' },
};

export interface Enumerated {
  operations: SweepOperation[];
  skipped: SkippedOperation[];
}

/**
 * The operations of the document that have a path parameter naming an object and that the API implements. A path parameter that is not
 * the id of an object (a fiscal year, a provider name) is skipped with the reason, as is an operation whose body cannot be made.
 */
export function enumerateSweep(document: OpenApiDocument, implemented: ReadonlySet<string>): Enumerated {
  const operations: SweepOperation[] = [];
  const skipped: SkippedOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.includes('{')) continue;
    for (const method of METHODS) {
      const raw = item[method];
      if (!isObject(raw)) continue;
      const operation = raw as OpenApiOperationObject;
      const operationId = operation.operationId ?? '';
      if (!implemented.has(operationId)) continue;
      const parameters = (operation.parameters ?? []).map((parameter) => parameterOf(document, parameter));
      const slots = slotsOf(path);
      const notId = slots.find((slot) => {
        const declared = parameters.find((parameter) => parameter.in === 'path' && parameter.name === slot.name);
        return !ID_NAME.test(slot.name) || declared?.schema?.type === 'integer';
      });
      if (notId !== undefined) {
        skipped.push({ operationId, method, path, reason: `the path parameter ${notId.name} does not name an object` });
        continue;
      }
      try {
        const query = parameters
          .filter((parameter) => parameter.in === 'query' && parameter.required === true && parameter.schema !== undefined)
          .map((parameter) => ({ name: parameter.name ?? '', value: QUERY_PATCHES[operationId]?.[parameter.name ?? ''] ?? String(instanceOf(document, parameter.schema ?? {}, 0, parameter.name ?? '')) }));
        const schema = operation.requestBody?.content?.['application/json']?.schema;
        operations.push({
          operationId,
          method,
          path,
          plane: operation['x-plane'] ?? 'tenant',
          slots,
          query,
          body: schema === undefined ? undefined : withPatch(operationId, instanceOf(document, schema)),
          versioned: parameters.some((parameter) => parameter.in === 'header' && parameter.name?.toLowerCase() === 'if-match'),
        });
      } catch (error) {
        skipped.push({ operationId, method, path, reason: `no valid request could be made: ${(error as Error).message}` });
      }
    }
  }
  operations.sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  return { operations, skipped };
}

const snake = (text: string): string => text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The names a table of the kind of object might have, most likely first: `/projects/{id}` gives `project`, `/bi/datasets/{id}` gives `bi_dataset` and `dataset`. */
export function tableCandidates(operation: SweepOperation, slot: PathSlot): string[] {
  const own = slot.name === 'id' ? slot.segment : slot.name.replace(/Id$/, '').replace(/_id$/, '');
  const base = singular(snake(own));
  const first = snake(operation.path.split('/').find((segment) => segment !== '' && segment !== 'resources') ?? '');
  const names = [base, `${first}_${base}`, `${singular(first)}_${base}`, `${base}_version`];
  return [...new Set(names.filter((name) => name !== '' && !name.startsWith('_')))];
}

/** The path of an operation with every path parameter given an id. */
export function fill(operation: SweepOperation, idFor: (slot: PathSlot) => string): string {
  const slots = [...operation.slots];
  return operation.path.replace(PATH_PARAMETER, () => encodeURIComponent(idFor(slots.shift() ?? { name: 'id', segment: '' })));
}
