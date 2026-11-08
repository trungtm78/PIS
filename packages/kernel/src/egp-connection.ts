import { DomainError } from './errors.ts';
import { EGP_LAYOUT_KINDS, EGP_LAYOUT_VERSIONS, EGP_SUBJECT_TYPES, egpAcceptance, egpConnectorHealth } from './egp.ts';
import type { EgpAcceptance, EgpConnectorHealth, EgpFreshnessParams, EgpLayoutKind, EgpSubjectType } from './egp.ts';
import { hasControlChar, hasControlCharExceptWhitespace } from './control-chars.ts';
import type { AdapterStatus } from './connector.ts';

/**
 * The management of the connector `egp.muasamcong` (EGP-1 part 2, BID-22 to BID-24): the pure rules that the store and the controllers apply and the tests pin. Nothing here reads the database or
 * the network. The mapping states are the ones `master_crosswalk` holds for the codes of the national network (PROPOSED, ACTIVE, REJECTED, RETIRED), the connection can be switched off with a reason,
 * and a file is applied only to a connection that is on and only for a layout version the module knows.
 */

/** The reason of a decision that changes what the register believes: ten characters at least, no control character, at most 2000. */
export const EGP_MIN_REASON = 10;
export const EGP_MAX_REASON = 2000;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The text of a reason as it is kept (trimmed); anything shorter than the minimum or with a control character is 422 `VALIDATION_FAILED` naming the field. */
export function egpReasonOf(value: unknown, field = 'reason', min: number = EGP_MIN_REASON): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text.length < min || text.length > EGP_MAX_REASON || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The connection: on or off, with the reason.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpConnectionState {
  enabled: boolean;
  version: number;
}

/**
 * Switching the connection. A file is applied only while it is on; a dry run is allowed either way (it writes nothing). Both directions need a reason, and a move to the state the connection is
 * already in is refused (422 `VALIDATION_FAILED`, `enabled`) so that an audit row always means a change.
 */
export function egpConnectionMove(current: Pick<EgpConnectionState, 'enabled'>, target: { enabled: unknown; reason: unknown }): { enabled: boolean; reason: string } {
  if (typeof target.enabled !== 'boolean') throw invalid('enabled');
  if (target.enabled === current.enabled) throw invalid('enabled');
  return { enabled: target.enabled, reason: egpReasonOf(target.reason) };
}

/** An apply of a file needs the connection on (409 `EGP_CONNECTION_DISABLED`). */
export function assertEgpApplyAllowed(connection: Pick<EgpConnectionState, 'enabled'>): void {
  if (!connection.enabled) throw new DomainError('EGP_CONNECTION_DISABLED', 409, 'connection');
}

/**
 * The layout version of a request must be one the module reads. Another one is refused before the file is opened, and the answer names the version that was asked and the ones that exist
 * (422 `EGP_LAYOUT_VERSION_UNKNOWN`, `extensions.layout_version`, `extensions.supported`), so a person who exported a file under a newer layout knows what to ask for.
 */
export function assertEgpLayoutKnown(version: string | undefined): string {
  const asked = version ?? EGP_LAYOUT_VERSIONS[EGP_LAYOUT_VERSIONS.length - 1];
  if (asked === undefined || !EGP_LAYOUT_VERSIONS.includes(asked)) {
    throw new DomainError('EGP_LAYOUT_VERSION_UNKNOWN', 422, 'mapping_version', { extensions: { layout_version: version ?? null, supported: [...EGP_LAYOUT_VERSIONS] } });
  }
  return asked;
}

export const isEgpLayoutKind = (value: unknown): value is EgpLayoutKind => typeof value === 'string' && (EGP_LAYOUT_KINDS as readonly string[]).includes(value);

/** The kind of a request, or 422 `VALIDATION_FAILED` naming `kind`. */
export function egpKindOf(value: unknown): EgpLayoutKind {
  if (!isEgpLayoutKind(value)) throw invalid('kind');
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The five positions of the file import framework.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The `connector_code` of the file import framework for each layout (the position of the connector, `integration_cursor`). */
export const EGP_POSITIONS: Readonly<Record<EgpLayoutKind, string>> = {
  KHLCNT: 'EGP_KHLCNT_FILE',
  TBMT: 'EGP_TBMT_FILE',
  RESULT: 'EGP_RESULT_FILE',
  CONTRACTOR: 'EGP_CONTRACTOR_FILE',
  RESTRICTION: 'EGP_RESTRICTION_FILE',
};

/** The layout a position stands for, or undefined for any other connector. */
export function egpKindOfPosition(connectorCode: string): EgpLayoutKind | undefined {
  return EGP_LAYOUT_KINDS.find((kind) => EGP_POSITIONS[kind] === connectorCode);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The mapping: who proposes, who decides.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const EGP_MAPPING_STATUSES = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;
export type EgpMappingStatus = (typeof EGP_MAPPING_STATUSES)[number];

export type EgpMappingMove = 'APPROVE' | 'REJECT' | 'RETIRE';

/** The edges of the life of a mapping. ACTIVE is reached only by an approval; REJECTED and RETIRED are final (a mapping that was wrong is replaced by a new proposal, so the history stays). */
export const EGP_MAPPING_MOVES: Readonly<Record<EgpMappingMove, { from: EgpMappingStatus; to: EgpMappingStatus; minReason: number }>> = {
  APPROVE: { from: 'PROPOSED', to: 'ACTIVE', minReason: EGP_MIN_REASON },
  REJECT: { from: 'PROPOSED', to: 'REJECTED', minReason: EGP_MIN_REASON },
  RETIRE: { from: 'ACTIVE', to: 'RETIRED', minReason: EGP_MIN_REASON },
};

/**
 * Applies a move to a mapping. A mapping not in the state the move starts from is 409 `EGP_MAPPING_STATE_INVALID`. The person who proposed a mapping (the person who loaded the file that proposed it,
 * for an import) does not approve or reject it (403 `SELF_APPROVAL_DENIED`: maker is not approver). The reason is checked last, so a stale screen sees the conflict first.
 */
export function egpMappingMove(mapping: { status: EgpMappingStatus; proposedBy: string }, step: { move: EgpMappingMove; actorId: string; reason: unknown }): { to: EgpMappingStatus; reason: string } {
  const edge = EGP_MAPPING_MOVES[step.move];
  if (edge === undefined) throw invalid('move');
  if (mapping.status !== edge.from) throw new DomainError('EGP_MAPPING_STATE_INVALID', 409, 'status');
  if (step.move !== 'RETIRE' && mapping.proposedBy === step.actorId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  return { to: edge.to, reason: egpReasonOf(step.reason, 'reason', edge.minReason) };
}

export const isEgpSubjectType = (value: unknown): value is EgpSubjectType => typeof value === 'string' && (EGP_SUBJECT_TYPES as readonly string[]).includes(value);

/** What a person may ask for when proposing a mapping by hand: a subject, our code, their code, the days it holds. The store resolves our code to the row. */
export interface EgpMappingRequest {
  subjectType: EgpSubjectType;
  ourCode: string;
  ourProjectCode: string | null;
  externalCode: string;
  validFrom: string | null;
  validUntil: string | null;
  confidence: number | null;
  method: 'MANUAL' | 'NAME_SUGGESTION';
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The request of a hand-made proposal, judged field by field (422 `VALIDATION_FAILED` naming the field). A contractor is mapped by tax code only, so a name suggestion is never one. */
export function egpMappingRequestOf(body: Readonly<Record<string, unknown>>): EgpMappingRequest {
  if (!isEgpSubjectType(body.subject_type)) throw invalid('subject_type');
  const text = (value: unknown, field: string, max: number, optional = false): string | null => {
    if (value === undefined || value === null) {
      if (optional) return null;
      throw invalid(field);
    }
    if (typeof value !== 'string') throw invalid(field);
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > max || hasControlChar(trimmed)) throw invalid(field);
    return trimmed;
  };
  const day = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
    return value;
  };
  const method = body.match_method === undefined ? 'MANUAL' : body.match_method;
  if (method !== 'MANUAL' && method !== 'NAME_SUGGESTION') throw invalid('match_method');
  let confidence: number | null = null;
  if (method === 'NAME_SUGGESTION') {
    if (body.subject_type === 'CONTRACTOR') throw invalid('match_method');
    if (typeof body.confidence !== 'number' || !(body.confidence > 0 && body.confidence <= 1)) throw invalid('confidence');
    confidence = Math.round(body.confidence * 1000) / 1000;
  } else if (body.confidence !== undefined && body.confidence !== null) throw invalid('confidence');
  const validFrom = day(body.valid_from, 'valid_from');
  const validUntil = day(body.valid_until, 'valid_until');
  if (validFrom !== null && validUntil !== null && validUntil <= validFrom) throw invalid('valid_until');
  return {
    subjectType: body.subject_type,
    ourCode: text(body.our_code, 'our_code', 100) as string,
    ourProjectCode: text(body.our_project_code, 'our_project_code', 50, true),
    externalCode: text(body.external_code, 'external_code', 100) as string,
    validFrom,
    validUntil,
    confidence,
    method,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The view of the connection.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpConnectionView {
  health: EgpConnectorHealth;
  acceptance: EgpAcceptance;
  enabled: boolean;
  /** The file adapter reads files; the API adapter is waiting for the operator and says so. */
  mode: 'FILE_IMPORT';
  apiAdapter: { status: AdapterStatus; reason: 'OPERATOR_SPECIFICATION_PENDING' };
  /** The connection is switched off: a file cannot be applied, and the screen says it instead of showing the last numbers as if they were live. */
  applyBlocked: boolean;
}

/**
 * What BID-22 shows: the health (the age of the last applied file against the rule `CONNECTOR_FRESHNESS`, code `EGP_FILE`), the acceptance word of the layout, whether the connection is on. A
 * connection that is off is not "fresh": `applyBlocked` is true and the health is still computed from the last import, so a person sees both.
 */
export function egpConnectionView(input: { lastImportAt: Date | null; now: Date; params: EgpFreshnessParams; enabled: boolean; adapterStatus?: AdapterStatus; layoutVersion?: string }): EgpConnectionView {
  const health = egpConnectorHealth({ lastImportAt: input.lastImportAt, now: input.now, params: input.params, ...(input.adapterStatus === undefined ? {} : { adapterStatus: input.adapterStatus }), ...(input.layoutVersion === undefined ? {} : { layoutVersion: input.layoutVersion }) });
  return {
    health,
    acceptance: egpAcceptance(health.layoutVersion),
    enabled: input.enabled,
    mode: 'FILE_IMPORT',
    apiAdapter: { status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' },
    applyBlocked: !input.enabled,
  };
}

/** Reads the parameters of the freshness rule as numbers; a value that is not a number or a severity falls back to nothing, so the caller refuses to compute instead of guessing. */
export function egpFreshnessParamsOf(params: Readonly<Record<string, unknown>>): EgpFreshnessParams {
  const hours = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
    return value;
  };
  const severity = params.stale_severity;
  if (severity !== 'URGENT' && severity !== 'ACTION' && severity !== 'WATCH') throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'stale_severity');
  if (typeof params.figures_blocked_when_stale !== 'boolean') throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'figures_blocked_when_stale');
  return { max_age_hours: hours(params.max_age_hours, 'max_age_hours'), warn_after_hours: hours(params.warn_after_hours, 'warn_after_hours'), stale_severity: severity, figures_blocked_when_stale: params.figures_blocked_when_stale };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the import writes about a mapping it proposes.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The difference code an import opens when a mapping it would propose cannot be (another subject holds the code; the subject already holds another code). */
export const EGP_MAPPING_DIFFERENCE_CODES = { EXTERNAL_CODE_TAKEN: 'EGP_EXTERNAL_CODE_TAKEN', SUBJECT_HAS_OTHER_CODE: 'EGP_SUBJECT_HAS_OTHER_CODE', OUR_CODE_UNKNOWN: 'EGP_OUR_CODE_UNKNOWN' } as const;
