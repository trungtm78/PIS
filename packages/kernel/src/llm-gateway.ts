import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { CLASSIFICATIONS, routesFor } from './llm-registry.ts';
import type { Classification, PublishedPolicy, Route } from './llm-registry.ts';

/**
 * The request path of the AI gateway (ST-LLM-005, LLM F1, BR-LLM-01, BR-LLM-02): the class of a request is the highest class of its sources and is never said by the caller; the routes it may take are those of the policy in
 * force, the profile and the models that are approved and priced; a request falls back only inside those routes; and what a model answers is checked (schema, citations) before anything is kept. Nothing here holds
 * the text of a request or of an answer: only hashes and counts are ever kept.
 */

// ---- classification -----------------------------------------------------------------------------------------------------------------------------

export interface SourceClass {
  documentVersionId: string;
  classification: Classification;
}

export interface Classified {
  classification: Classification;
  basis: Array<{ document_version_id: string; classification: Classification }>;
}

/** BR-LLM-02: the highest class of the sources (public < internal < confidential < personal < important core; personal data is kept above confidential, which takes the same routes). */
export function classifySources(sources: readonly SourceClass[]): Classified {
  if (sources.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'source_refs');
  let highest = 0;
  for (const source of sources) {
    const rank = CLASSIFICATIONS.indexOf(source.classification);
    if (rank < 0) throw new DomainError('VALIDATION_FAILED', 422, 'source_refs');
    highest = Math.max(highest, rank);
  }
  return {
    classification: CLASSIFICATIONS[highest] as Classification,
    basis: sources.map((source) => ({ document_version_id: source.documentVersionId, classification: source.classification })),
  };
}

// ---- the route ----------------------------------------------------------------------------------------------------------------------------------

export interface RouteCandidate {
  modelRefId: string;
  /** The identifier the provider knows the model by. */
  modelId: string;
  providerId: string;
  providerCode: string;
  route: Route;
  pricingVersionId: string;
}

export interface RoutePlanInput {
  classification: Classification;
  /** The highest class the profile takes. */
  profileMax: Classification;
  profileRoutes: readonly Route[];
  /** The policy in force; none means the baseline with the international route off. */
  policy: PublishedPolicy | undefined;
  /** The models the profile may use, in the order it lists them, that are approved, on an active provider and have a price in force. */
  candidates: readonly RouteCandidate[];
  /** The identifier of the primary model of the profile. */
  primaryModelId: string;
}

export type RoutePlan = { ok: true; attempts: RouteCandidate[]; allowedRoutes: Route[] } | { ok: false; code: 'AI_ROUTE_NOT_ALLOWED'; detail: string };

/**
 * BR-LLM-01: the routes of a request are the routes of the policy for its class, within the routes of the profile; the models are tried in this order: the primary model first, then the others as the profile lists them.
 * A request whose class the profile does not take, or that no approved model can serve on an allowed route, is refused: it is never sent over a route it is not allowed.
 */
export function planRoute(input: RoutePlanInput): RoutePlan {
  if (CLASSIFICATIONS.indexOf(input.classification) > CLASSIFICATIONS.indexOf(input.profileMax)) return { ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'max_classification' };
  const policyRoutes = routesFor(input.classification, input.policy);
  // The international route is for public data whatever a policy says: the check is made again here, where the route is chosen.
  const allowed = policyRoutes.filter((route) => input.profileRoutes.includes(route) && (route !== 'INTERNATIONAL' || input.classification === 'PUBLIC'));
  if (allowed.length === 0) return { ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'route' };
  const usable = input.candidates.filter((candidate) => allowed.includes(candidate.route));
  if (usable.length === 0) return { ok: false, code: 'AI_ROUTE_NOT_ALLOWED', detail: 'model' };
  const primary = usable.find((candidate) => candidate.modelId === input.primaryModelId);
  const attempts = primary === undefined ? [...usable] : [primary, ...usable.filter((candidate) => candidate !== primary)];
  return { ok: true, attempts, allowedRoutes: allowed };
}

// ---- the port -----------------------------------------------------------------------------------------------------------------------------------

export interface GatewayCall {
  route: Route;
  providerCode: string;
  providerModelId: string;
  /** Where the module that asks keeps the input: a pointer, never the text. */
  inputRef: string;
  inputSha256: string;
  /** The template of the prompt the profile runs (the key in the document store and its hash): the adapter reads it to build the prompt. */
  promptTemplateKey: string;
  promptSha256: string;
  /** The document versions the input is made of: what the adapter reads to build the prompt. */
  sourceIds: readonly string[];
  outputSchema: unknown;
  maxOutputTokens: number;
  effort: string | null;
  timeoutMs: number;
  /** The tools the model may call: only tools that read. */
  tools: readonly string[];
}

export interface GatewayResult {
  providerRequestId: string;
  /** What the model answered, as the JSON text of an answer that follows the schema of the profile. It is checked and hashed here and is never kept. */
  output: string;
  usage: { inputTotal: number; cachedInput: number; outputTotal: number };
  latencyMs: number;
}

export type GatewayFailureKind = 'TIMEOUT' | 'REFUSAL' | 'PROVIDER_ERROR';

/** What a call to a provider that did not answer says: nothing of the provider's own message is kept, because it can carry what was sent. */
export class GatewayFailure extends Error {
  readonly kind: GatewayFailureKind;

  constructor(kind: GatewayFailureKind) {
    super(kind);
    this.name = 'GatewayFailure';
    this.kind = kind;
  }
}

export interface AiGatewayPort {
  complete(call: GatewayCall): Promise<GatewayResult>;
  /** Asks the provider to stop a request that is still running; true when it did. A provider that cannot stop one answers false, and the answer is discarded when it comes. */
  cancel?(providerRequestId: string): Promise<boolean>;
}

// ---- the checks after the answer ----------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a keyword of a schema of a profile may be: the ones that are checked (below) and the ones that only describe. */
const CHECKED_KEYWORDS = ['type', 'properties', 'required', 'items', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'additionalProperties'];
const ANNOTATIONS = ['title', 'description', 'default', 'examples', '$comment', '$schema'];
/** A day of the calendar: the month and the day exist in that year (2026-02-29 does not). */
function isDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const moment = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day;
}

/** A moment with a day of the calendar, a time of the day (a leap second is allowed) and a zone. */
function isMoment(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (match === null || !isDay(match[1] as string)) return false;
  const [hour, minute, second] = [Number(match[2]), Number(match[3]), Number(match[4])];
  const zone = match[5] === undefined ? [0, 0] : [Number(match[5]), Number(match[6])];
  return hour <= 23 && minute <= 59 && second <= 60 && (zone[0] as number) <= 23 && (zone[1] as number) <= 59;
}

const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  date: isDay,
  'date-time': isMoment,
};
const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

/**
 * The first keyword of an output schema that the gateway cannot check (`$ref`, `oneOf`, `patternProperties`, an unknown format...): a schema that says more than the gateway verifies is refused when the profile is drafted,
 * so that an answer is never taken as valid by a rule that was not applied.
 */
export function unsupportedSchemaKeyword(schema: unknown, path = ''): string | undefined {
  if (typeof schema === 'boolean') return undefined;
  if (!isRecord(schema)) return path === '' ? 'schema' : path;
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.includes(key)) continue;
    if (!CHECKED_KEYWORDS.includes(key)) return `${path}${key}`;
  }
  // The value of each keyword is of the shape the check reads: a limit that is a string, or a list of required names that is not a list, would be ignored and the output would go unchecked.
  const count = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (key in schema && !count(schema[key])) return `${path}${key}`;
  for (const key of ['minimum', 'maximum']) if (key in schema && !(typeof schema[key] === 'number' && Number.isFinite(schema[key]))) return `${path}${key}`;
  if ('pattern' in schema && typeof schema.pattern !== 'string') return `${path}pattern`;
  if ('format' in schema && typeof schema.format !== 'string') return `${path}format`;
  if ('required' in schema && !(Array.isArray(schema.required) && schema.required.every((name) => typeof name === 'string'))) return `${path}required`;
  if ('enum' in schema && !(Array.isArray(schema.enum) && schema.enum.length > 0)) return `${path}enum`;
  if ('properties' in schema && !isRecord(schema.properties)) return `${path}properties`;
  if ('items' in schema && typeof schema.items !== 'boolean' && !isRecord(schema.items)) return `${path}items`;
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean' && !isRecord(schema.additionalProperties)) return `${path}additionalProperties`;
  const type = schema.type;
  if (type !== undefined && !(typeof type === 'string' ? TYPES.includes(type) : Array.isArray(type) && type.length > 0 && type.every((entry) => typeof entry === 'string' && TYPES.includes(entry)))) return `${path}type`;
  if (typeof schema.format === 'string' && !own(FORMATS, schema.format)) return `${path}format`;
  if (typeof schema.pattern === 'string') {
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      return `${path}pattern`;
    }
  }
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      const found = unsupportedSchemaKeyword(sub, `${path}properties.${name}.`);
      if (found !== undefined) return found;
    }
  }
  if (schema.items !== undefined) {
    const found = unsupportedSchemaKeyword(schema.items, `${path}items.`);
    if (found !== undefined) return found;
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return unsupportedSchemaKeyword(schema.additionalProperties, `${path}additionalProperties.`);
  return undefined;
}

const own = (value: object, name: string): boolean => Object.prototype.hasOwnProperty.call(value, name);

/** Equality of two JSON values as the schema means it: the order of the properties of an object does not matter. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((entry, index) => sameJson(entry, right[index]));
  if (isRecord(left)) {
    if (!isRecord(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => own(right, key) && sameJson(left[key], right[key]));
  }
  return Object.is(left, right) || (left === 0 && right === 0);
}

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value);
const hasType = (value: unknown, type: string): boolean => (type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeOf(value) === type);

/**
 * The part of JSON Schema that the profiles may use (see `unsupportedSchemaKeyword`): type (one or several), properties, required, additionalProperties, items, enum, const, the limits of strings, numbers and arrays,
 * `pattern` and the formats uuid, date and date-time. An answer that does not follow every one of them is not used.
 */
export function followsSchema(value: unknown, schema: unknown): boolean {
  if (schema === false) return false;
  if (!isRecord(schema)) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameJson(entry, value))) return false;
  if (own(schema, 'const') && !sameJson(schema.const, value)) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeof type === 'string' && hasType(value, type))) return false;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) return false;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return false;
    if (typeof schema.format === 'string' && !(own(FORMATS, schema.format) && FORMATS[schema.format]?.(value))) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((entry) => followsSchema(entry, schema.items))) return false;
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!required.every((name) => typeof name === 'string' && own(value, name))) return false;
    if (!Object.entries(properties).every(([name, sub]) => !own(value, name) || followsSchema(value[name], sub))) return false;
    if (schema.additionalProperties !== undefined) {
      const extra = Object.keys(value).filter((name) => !own(properties, name));
      if (schema.additionalProperties === false && extra.length > 0) return false;
      if (typeof schema.additionalProperties !== 'boolean' && !extra.every((name) => followsSchema(value[name], schema.additionalProperties))) return false;
    }
  }
  return true;
}

/** A profile whose output schema requires `citations` needs every answer to carry them (BR-LLM-10). */
export const requiresCitations = (outputSchema: unknown): boolean => isRecord(outputSchema) && Array.isArray(outputSchema.required) && outputSchema.required.includes('citations');

export type PostCheck =
  | { ok: true; outputSha256: string; citations: number }
  | { ok: false; code: 'INVALID_JSON' | 'REJECTED_NO_CITATION' };

/**
 * LLM F1 step 7: the answer is JSON that follows the schema of the profile; when the profile requires citations every one of them points at a source of the request (a citation that points elsewhere does not exist), and there
 * is at least one. An answer that fails is not used and not kept.
 */
export function postCheck(input: { output: string; outputSchema: unknown; sourceIds: readonly string[] }): PostCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.output);
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }
  // A profile that requires citations is told first that there are none: an answer without them is not used whatever else is wrong with it.
  if (requiresCitations(input.outputSchema) && isRecord(parsed) && !(Array.isArray(parsed.citations) && parsed.citations.length > 0)) return { ok: false, code: 'REJECTED_NO_CITATION' };
  if (!followsSchema(parsed, input.outputSchema)) return { ok: false, code: 'INVALID_JSON' };
  let citations = 0;
  if (isRecord(parsed) && Array.isArray(parsed.citations)) {
    const cited = parsed.citations.map((entry) => (isRecord(entry) && typeof entry.document_version_id === 'string' ? entry.document_version_id : undefined));
    if (cited.some((id) => id === undefined || !input.sourceIds.includes(id))) return { ok: false, code: 'REJECTED_NO_CITATION' };
    citations = cited.length;
  }
  if (requiresCitations(input.outputSchema) && citations === 0) return { ok: false, code: 'REJECTED_NO_CITATION' };
  return { ok: true, outputSha256: createHash('sha256').update(input.output).digest('hex'), citations };
}

/** How many times the same model is asked again for an answer that failed the checks (the answer was paid for; one more try is the limit). */
export const MAX_CHECK_RETRIES = 1;

// ---- the emergency stop -------------------------------------------------------------------------------------------------------------------------

export const KILL_SCOPES = ['TENANT', 'PROVIDER', 'MODEL', 'PROFILE', 'TASK_TYPE'] as const;
export type KillScope = (typeof KILL_SCOPES)[number];

export interface KillSwitch {
  id: string;
  scopeKind: KillScope;
  scopeRef: string | null;
}

/** What a request or an attempt is, as far as a switch is concerned: the task, and (for an attempt or a request that has chosen) the provider and the model. */
export interface KillProbe {
  taskType: string;
  providerId?: string | null | undefined;
  modelRefId?: string | null | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LLM F7: what a switch is for. The whole tenant needs no reference; a provider or a model is named by its id in the registry; a profile or a task type by the name of the task. */
export function assertKillScope(kind: string, ref: string | undefined): string | null {
  if (!(KILL_SCOPES as readonly string[]).includes(kind)) throw new DomainError('VALIDATION_FAILED', 422, 'scope_kind');
  const text = ref?.trim() ?? '';
  if (kind === 'TENANT') {
    if (text !== '') throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
    return null;
  }
  if ((kind === 'PROVIDER' || kind === 'MODEL') && !UUID.test(text)) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
  if ((kind === 'PROFILE' || kind === 'TASK_TYPE') && (text.length < 2 || text.length > 60)) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
  return kind === 'PROVIDER' || kind === 'MODEL' ? text.toLowerCase() : text;
}

/** The first of the switches that engaged and stops this probe. A provider or a model that is not chosen yet is not stopped by a switch of its own. */
export function killedBy(switches: readonly KillSwitch[], probe: KillProbe): KillSwitch | undefined {
  return switches.find((entry) => {
    switch (entry.scopeKind) {
      case 'TENANT':
        return true;
      case 'PROFILE':
      case 'TASK_TYPE':
        return entry.scopeRef === probe.taskType;
      case 'PROVIDER':
        return probe.providerId !== undefined && probe.providerId !== null && entry.scopeRef?.toLowerCase() === probe.providerId.toLowerCase();
      case 'MODEL':
        return probe.modelRefId !== undefined && probe.modelRefId !== null && entry.scopeRef?.toLowerCase() === probe.modelRefId.toLowerCase();
    }
  });
}
