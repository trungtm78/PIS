import { DomainError } from './errors.ts';
import { hasControlChar } from './control-chars.ts';
import { egpReasonOf } from './egp-connection.ts';
import type { Edition } from './edition.ts';

/**
 * INT-1, the open interface of the platform: machine accounts with client credentials, the scopes they hold, the rate limit they live under, the datasets that are certified for external readers and the login
 * of a BI tool (Lakehouse, Power BI) that reads them. Pure rules only: nothing here reads the database, the clock (it is passed in) or the network. The secrets are made in `open-api-secret.ts`.
 *
 * What the rules hold (eng-review R6 and R13):
 *  - a machine reads only what a scope names, and only the tenant of its own account; every read is written to the access log by the caller;
 *  - a dataset leaves the platform only while it is switched on for external readers AND the data product behind it is CERTIFIED and not past its day;
 *  - a BI login is bound to one tenant by its own name (`current_user`), never by a session setting a login could change.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Scopes and datasets.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The datasets an external reader may be given (API and BI). The code is the stable name; `view` is the certified view of the BI reader schema. */
export const OPEN_DATASETS = ['DS-DISB', 'DS-CTR'] as const;
export type OpenDatasetCode = (typeof OPEN_DATASETS)[number];

export interface OpenDatasetDefinition {
  code: OpenDatasetCode;
  /** The view the BI login reads, in the schema `machvon_bi`. */
  view: string;
  /** The scope of the open API that reads the same dataset. */
  scope: string;
  /** What one row is. */
  grain: string;
  /** The columns of the view, in order: the documentation an external reader sees. */
  columns: readonly string[];
}

/** The certified datasets, one row each. Both are read from FROZEN snapshots (immutable), never from live tables. */
export const OPEN_DATASET_DEFINITIONS: Readonly<Record<OpenDatasetCode, OpenDatasetDefinition>> = {
  'DS-DISB': {
    code: 'DS-DISB',
    view: 'v_disbursement_lines',
    scope: 'open.disbursement.read',
    grain: 'one row per project, unit, fund source version and bucket of a frozen close snapshot of a reporting period',
    columns: [
      'tenant_id', 'snapshot_id', 'period_id', 'as_of_date', 'line_id', 'project_id', 'unit_id', 'fund_source_version_id', 'bucket', 'budget_level', 'plan_total_vnd', 'disbursed_treasury_vnd', 'disbursed_reported_vnd',
      'period_delta_vnd', 'rate_total_pct', 'rate_null_reason', 'treasury_coverage', 'certification_expires_on',
    ],
  },
  'DS-CTR': {
    code: 'DS-CTR',
    view: 'v_contract_lines',
    scope: 'open.contracts.read',
    grain: 'one row per contract and active party of a frozen contract fact snapshot',
    columns: [
      'tenant_id', 'snapshot_id', 'period_id', 'revision', 'cutoff_date', 'contract_id', 'contractor_id', 'is_lead', 'share_pct', 'project_id', 'unit_id', 'contract_status', 'contract_type', 'contract_value_vnd', 'active_value_vnd', 'paid_vnd', 'certification_expires_on',
    ],
  },
};

export const isOpenDataset = (value: unknown): value is OpenDatasetCode => typeof value === 'string' && (OPEN_DATASETS as readonly string[]).includes(value);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The datasets of the enterprise edition (INT-2).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The certified datasets only the enterprise edition lets out, and only to BI logins (Power BI, Lakehouse): there is no open API scope for them. `DS-ENT` is the frozen enterprise period snapshot (kind
 * ENTERPRISE_CLOSE, ENT-3a), which the two datasets above never read. A public process does not offer them (`biDatasetsOfEdition`), so a public tenant cannot switch one on and the lists a public screen shows are
 * what they always were.
 */
export const ENTERPRISE_BI_DATASETS = ['DS-ENT'] as const;
export type EnterpriseBiDatasetCode = (typeof ENTERPRISE_BI_DATASETS)[number];
/** Every dataset a tenant may switch on for external readers, of any edition. */
export type BiDatasetCode = OpenDatasetCode | EnterpriseBiDatasetCode;

/** One certified view of the BI reader schema. */
export interface BiView {
  view: string;
  grain: string;
  columns: readonly string[];
}

export interface EnterpriseBiDatasetDefinition {
  code: EnterpriseBiDatasetCode;
  /** The views the BI login reads, in the schema `machvon_bi`; the first one is the base the others are made from. */
  views: readonly BiView[];
}

const ENTERPRISE_PERIOD_COLUMNS = ['tenant_id', 'snapshot_id', 'period_id', 'revision', 'as_of_date'] as const;

/** The certified views of the enterprise dataset DS-ENT; the test of the database pins these columns to the views. */
export const ENTERPRISE_BI_DATASET_DEFINITIONS: Readonly<Record<EnterpriseBiDatasetCode, EnterpriseBiDatasetDefinition>> = {
  'DS-ENT': {
    code: 'DS-ENT',
    views: [
      {
        view: 'v_enterprise_figures',
        grain: 'one row per figure (project, class, tier, measure, figure kind, grain, ordinal) of the frozen enterprise period snapshot of a period',
        columns: [...ENTERPRISE_PERIOD_COLUMNS, 'project_id', 'unit_id', 'class_code', 'tier_code', 'measure', 'figure_kind', 'grain', 'plan_year', 'ordinal', 'amount_vnd', 'null_reason', 'basis', 'certification_expires_on'],
      },
      {
        view: 'v_enterprise_plan_actual',
        grain: 'one row per project, class, tier and measure of the frozen enterprise period snapshot of a period: the plan, the actual, the cumulative and the rates side by side',
        columns: [
          ...ENTERPRISE_PERIOD_COLUMNS, 'period_grain', 'plan_year', 'period_ordinal', 'project_id', 'unit_id', 'class_code', 'tier_code', 'measure', 'plan_year_vnd', 'plan_adjusted_vnd', 'plan_in_force_vnd', 'plan_period_vnd', 'plan_to_date_vnd',
          'estimate_vnd', 'estimate_as_reported_vnd', 'actual_vnd', 'cumulative_ytd_vnd', 'cumulative_since_start_vnd', 'estimate_year_vnd', 'rate_in_force_pct', 'rate_to_date_pct', 'certification_expires_on',
        ],
      },
      {
        view: 'v_enterprise_funding_split',
        grain: 'one row per project and measure of the frozen enterprise period snapshot of a period: the plan in force and the cumulative by source of funds (equity, loan, other)',
        columns: [
          ...ENTERPRISE_PERIOD_COLUMNS, 'period_grain', 'plan_year', 'period_ordinal', 'project_id', 'unit_id', 'measure', 'plan_in_force_equity_vnd', 'plan_in_force_loan_vnd', 'plan_in_force_other_vnd', 'plan_in_force_total_vnd',
          'cumulative_ytd_equity_vnd', 'cumulative_ytd_loan_vnd', 'cumulative_ytd_other_vnd', 'cumulative_ytd_total_vnd', 'equity_share_pct', 'loan_share_pct', 'certification_expires_on',
        ],
      },
      {
        view: 'v_enterprise_by_unit',
        grain: 'one row per unit and measure, and one for the whole tenant, of the frozen enterprise period snapshot of a period: the sums over the projects with the rates made from the sums',
        columns: [
          ...ENTERPRISE_PERIOD_COLUMNS, 'period_grain', 'plan_year', 'period_ordinal', 'level', 'unit_id', 'measure', 'project_count', 'plan_in_force_vnd', 'plan_to_date_vnd', 'actual_vnd', 'cumulative_ytd_vnd', 'rate_in_force_pct',
          'rate_to_date_pct', 'cumulative_ytd_equity_vnd', 'cumulative_ytd_loan_vnd', 'cumulative_ytd_other_vnd', 'equity_share_pct', 'loan_share_pct', 'certification_expires_on',
        ],
      },
    ],
  },
};

/** The datasets a tenant of the edition may switch on for external readers: the open datasets, and the enterprise ones in the enterprise edition. */
export const biDatasetsOfEdition = (edition: Edition): readonly BiDatasetCode[] => (edition === 'enterprise' ? [...OPEN_DATASETS, ...ENTERPRISE_BI_DATASETS] : OPEN_DATASETS);

export const isBiDatasetOfEdition = (value: unknown, edition: Edition): value is BiDatasetCode => typeof value === 'string' && (biDatasetsOfEdition(edition) as readonly string[]).includes(value);

/** What an external reader is told about a dataset: the views it is read through (one for the open datasets, several for an enterprise one) and the open API scope when there is one (else an empty text). */
export function biDatasetFacts(code: BiDatasetCode): { scope: string; views: readonly BiView[] } {
  if (isOpenDataset(code)) {
    const definition = OPEN_DATASET_DEFINITIONS[code];
    return { scope: definition.scope, views: [{ view: definition.view, grain: definition.grain, columns: definition.columns }] };
  }
  return { scope: '', views: ENTERPRISE_BI_DATASET_DEFINITIONS[code].views };
}

export interface OpenApiScope {
  code: string;
  /** The dataset the scope reads, when it reads one that needs a certification; the registers carry none. */
  dataset: OpenDatasetCode | null;
}

/** The scopes of the open API. A scope names what a machine may read and nothing more; there is no write scope in this version. */
export const OPEN_API_SCOPES: readonly OpenApiScope[] = [
  { code: 'open.projects.read', dataset: null },
  { code: 'open.project-codes.read', dataset: null },
  { code: 'open.disbursement.read', dataset: 'DS-DISB' },
  { code: 'open.contracts.read', dataset: 'DS-CTR' },
];

export const OPEN_API_SCOPE_CODES: readonly string[] = OPEN_API_SCOPES.map((scope) => scope.code);

export const isOpenApiScope = (value: unknown): value is string => typeof value === 'string' && OPEN_API_SCOPE_CODES.includes(value);

/** The dataset a scope reads, if any. */
export const datasetOfScope = (scope: string): OpenDatasetCode | null => OPEN_API_SCOPES.find((entry) => entry.code === scope)?.dataset ?? null;

/** Whether the scopes a token carries include the one an operation needs (403 `OPEN_SCOPE_DENIED` otherwise). */
export function assertOpenScope(granted: readonly string[], required: string): void {
  if (!granted.includes(required)) throw new DomainError('OPEN_SCOPE_DENIED', 403, 'scope', { extensions: { required_scope: required } });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The certification gate of a dataset.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type DataProductCertification = 'NOT_ASSESSED' | 'PROVISIONAL' | 'CERTIFIED' | 'REVOKED';

export type DatasetGateReason = 'DISABLED' | 'NOT_CERTIFIED' | 'EXPIRED';

export interface DatasetGateInput {
  /** The tenant switched the dataset on for external readers. */
  enabled: boolean;
  /** The certification of the data product behind the dataset, as DGV holds it now. */
  certification: DataProductCertification | null;
  /** The day the certification runs out (inclusive of the day before), or null when it has no end. */
  expiresOn: string | null;
  /** Today in Vietnam, `yyyy-mm-dd`. */
  today: string;
}

/**
 * Whether a dataset may leave the platform now. It may only when it is switched on, its product is CERTIFIED and the certification has not run out (the day it runs out is the first day it no longer holds).
 * The same verdict is what the certified views of the BI reader schema compute in SQL (`machvon_bi.dataset_gate`); the test of the database pins the two to each other.
 */
export function datasetGate(input: DatasetGateInput): { open: true } | { open: false; reason: DatasetGateReason } {
  if (!input.enabled) return { open: false, reason: 'DISABLED' };
  if (input.certification !== 'CERTIFIED') return { open: false, reason: 'NOT_CERTIFIED' };
  if (input.expiresOn !== null && input.expiresOn <= input.today) return { open: false, reason: 'EXPIRED' };
  return { open: true };
}

/** Throws `OPEN_DATASET_NOT_CERTIFIED` naming why the dataset is closed: 403 when a reader asks for it, 422 when a person tries to switch it on. */
export function assertDatasetOpen(input: DatasetGateInput, status: 403 | 422 = 403): void {
  const verdict = datasetGate(input);
  if (!verdict.open) throw new DomainError('OPEN_DATASET_NOT_CERTIFIED', status, 'dataset', { extensions: { reason: verdict.reason } });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Machine accounts.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const MACHINE_ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type MachineAccountStatus = (typeof MACHINE_ACCOUNT_STATUSES)[number];
export type MachineAccountMove = 'SUSPEND' | 'REACTIVATE' | 'REVOKE';

export const MACHINE_RATE_MIN = 1;
export const MACHINE_RATE_MAX = 6000;
export const MACHINE_RATE_DEFAULT = 60;
/** The longest a machine account may be given to live, and the longest overlap of an old secret after a rotation. */
export const MACHINE_MAX_LIFETIME_DAYS = 730;
export const MACHINE_GRACE_MAX_HOURS = 72;
export const MACHINE_GRACE_DEFAULT_HOURS = 24;
export const MACHINE_NAME_MAX = 120;
export const MACHINE_DESCRIPTION_MAX = 1000;

export interface MachineAccountRequest {
  name: string;
  description: string | null;
  scopes: string[];
  ratePerMinute: number;
  expiresOn: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day `yyyy-mm-dd` that exists, or 422 naming the field. */
export function dayOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DAY.test(value)) throw invalid(field);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

const textOf = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text === '' || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
};

/** The sorted, de-duplicated scopes of a request; at least one, every one a scope of the catalogue. */
export function scopesOf(value: unknown, field = 'scopes'): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > OPEN_API_SCOPES.length) throw invalid(field);
  const scopes = new Set<string>();
  for (const item of value) {
    if (!isOpenApiScope(item)) throw invalid(field);
    scopes.add(item);
  }
  return [...scopes].sort();
}

export function ratePerMinuteOf(value: unknown, field = 'rate_limit_per_minute'): number {
  if (value === undefined || value === null) return MACHINE_RATE_DEFAULT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MACHINE_RATE_MIN || value > MACHINE_RATE_MAX) throw invalid(field);
  return value;
}

/** A day the account runs out: after today, and within the longest lifetime. */
export function expiryOf(value: unknown, today: string, field = 'expires_on'): string | null {
  if (value === undefined || value === null) return null;
  const day = dayOf(value, field);
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + MACHINE_MAX_LIFETIME_DAYS);
  if (day <= today || day > limit.toISOString().slice(0, 10)) throw invalid(field);
  return day;
}

/** The request to open a machine account, judged field by field (422 `VALIDATION_FAILED` naming the field). */
export function machineAccountRequestOf(body: Readonly<Record<string, unknown>>, today: string): MachineAccountRequest {
  return {
    name: textOf(body.name, 'name', MACHINE_NAME_MAX),
    description: body.description === undefined || body.description === null ? null : textOf(body.description, 'description', MACHINE_DESCRIPTION_MAX),
    scopes: scopesOf(body.scopes),
    ratePerMinute: ratePerMinuteOf(body.rate_limit_per_minute),
    expiresOn: expiryOf(body.expires_on, today),
  };
}

export const MACHINE_ACCOUNT_MOVES: Readonly<Record<MachineAccountMove, { from: readonly MachineAccountStatus[]; to: MachineAccountStatus }>> = {
  SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED' },
  REACTIVATE: { from: ['SUSPENDED'], to: 'ACTIVE' },
  REVOKE: { from: ['ACTIVE', 'SUSPENDED'], to: 'REVOKED' },
};

export const isMachineAccountMove = (value: unknown): value is MachineAccountMove => typeof value === 'string' && Object.hasOwn(MACHINE_ACCOUNT_MOVES, value);

/**
 * Applies a move to a machine account: a suspension can be lifted, a revocation is final. A move from a state it does not start from is 409 `OPEN_ACCOUNT_STATE_INVALID`; the reason is checked last, so a stale
 * screen sees the conflict first. Reactivating an account whose own end day has passed is refused (it would be dead at once).
 */
export function machineAccountMove(account: { status: MachineAccountStatus; expiresOn: string | null }, step: { move: MachineAccountMove; reason: unknown; today: string }): { to: MachineAccountStatus; reason: string } {
  const edge = MACHINE_ACCOUNT_MOVES[step.move];
  if (edge === undefined) throw invalid('move');
  if (!edge.from.includes(account.status)) throw new DomainError('OPEN_ACCOUNT_STATE_INVALID', 409, 'status');
  if (step.move === 'REACTIVATE' && account.expiresOn !== null && account.expiresOn <= step.today) throw new DomainError('OPEN_ACCOUNT_STATE_INVALID', 409, 'expires_on');
  return { to: edge.to, reason: egpReasonOf(step.reason) };
}

/** Whether an account may authenticate now: ACTIVE and not past its own day. */
export const machineAccountLive = (account: { status: MachineAccountStatus; expiresOn: string | null }, today: string): boolean =>
  account.status === 'ACTIVE' && (account.expiresOn === null || account.expiresOn > today);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Credentials: a rotation keeps the old secret alive for a short, bounded overlap.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type MachineCredentialState = 'ACTIVE' | 'RETIRING' | 'EXPIRED' | 'REVOKED';

export interface MachineCredentialFacts {
  /** The day-time the credential stops working (null: until it is revoked or the account ends). */
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** Set when a newer credential replaced this one (the overlap runs to `expiresAt`). */
  supersededAt: Date | null;
}

export function machineCredentialState(credential: MachineCredentialFacts, now: Date): MachineCredentialState {
  if (credential.revokedAt !== null) return 'REVOKED';
  if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return credential.supersededAt === null ? 'ACTIVE' : 'RETIRING';
}

/** The overlap, in hours, an old secret keeps after a rotation: 0 to the maximum; absent means the default. */
export function graceHoursOf(value: unknown, field = 'grace_hours'): number {
  if (value === undefined || value === null) return MACHINE_GRACE_DEFAULT_HOURS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MACHINE_GRACE_MAX_HOURS) throw invalid(field);
  return value;
}

/** The moment the old secret stops working after a rotation made at `now`. */
export const graceEndsAt = (now: Date, hours: number): Date => new Date(now.getTime() + hours * 3_600_000);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rate limit of a machine account.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface MachineRateVerdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Whole seconds until the window of the account ends; 0 while requests are allowed. */
  retryAfterSeconds: number;
}

interface RateWindow {
  start: number;
  count: number;
}

/**
 * A fixed-window limiter with one counter per machine account and the limit of THAT account (each account carries its own). The same shape as the limiter of tenants (SAS-02), kept separate so one account
 * cannot spend the quota of another account or of its tenant. The counters live in the process; a window that has been idle is dropped. A fleet of processes multiplies the ceiling by their number,
 * which is why the access log, not this counter, is the record.
 */
export class MachineRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private readonly windowMs: number;

  private readonly options: { windowSeconds?: number; now?: () => number };

  constructor(options: { windowSeconds?: number; now?: () => number } = {}) {
    this.options = options;
    this.windowMs = (options.windowSeconds ?? 60) * 1000;
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) throw new RangeError('the window must be positive');
  }

  consume(accountId: string, limit: number): MachineRateVerdict {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('the limit must be a positive integer');
    const now = (this.options.now ?? Date.now)();
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
    const current = this.windows.get(accountId);
    const window = current !== undefined && now - current.start < this.windowMs ? current : { start: now, count: 0 };
    this.windows.set(accountId, window);
    if (window.count >= limit) return { allowed: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) };
    window.count += 1;
    return { allowed: true, limit, remaining: limit - window.count, retryAfterSeconds: 0 };
  }

  size(): number {
    return this.windows.size;
  }
}

/** The 429 a refused request is answered with, `Retry-After` and the limit headers included. */
export function rateLimitError(verdict: MachineRateVerdict): DomainError {
  return new DomainError('RATE_LIMIT', 429, undefined, { headers: { 'Retry-After': String(verdict.retryAfterSeconds), 'X-RateLimit-Limit': String(verdict.limit), 'X-RateLimit-Remaining': '0' } });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The access log: every read of a machine is a row.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const OPEN_ACCESS_OUTCOMES = ['OK', 'DENIED_CLIENT', 'DENIED_SCOPE', 'DENIED_DATASET', 'RATE_LIMITED', 'INVALID_REQUEST'] as const;
export type OpenAccessOutcome = (typeof OPEN_ACCESS_OUTCOMES)[number];

export interface OpenAccessEntry {
  accountId: string;
  credentialId: string;
  operation: string;
  scope: string;
  /** The path as called, without the query string: a filter value can be a business secret. */
  path: string;
  /** The names of the query parameters that were sent, never their values. */
  queryKeys: string[];
  outcome: OpenAccessOutcome;
  status: number;
  rowCount: number | null;
  correlationId: string;
}

/** The names of the query parameters of a request, sorted and bounded (the log keeps what was asked for by name, never by value). */
export function queryKeysOf(query: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(query)
    .filter((key) => /^[A-Za-z0-9_.-]{1,40}$/.test(key))
    .sort()
    .slice(0, 20);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Source systems and the codes of projects in them (the crosswalk, INT-1 part 3).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The `external_type` of the rows of `master_crosswalk` that hold the code of one of our projects in another system. */
export const PROJECT_CODE_EXTERNAL_TYPE = 'PROJECT_CODE';
/** The system names the e-GP lane and the other lanes own: a project code cannot be registered under them here. */
export const RESERVED_SOURCE_SYSTEMS: readonly string[] = ['MUASAMCONG', 'TENANT_ALIAS'];

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,29}$/;
export const SOURCE_SYSTEM_KINDS = ['PMIS', 'ERP', 'FINANCE', 'LAKEHOUSE', 'GOV_PORTAL', 'OTHER'] as const;
export type SourceSystemKind = (typeof SOURCE_SYSTEM_KINDS)[number];

export interface SourceSystemRequest {
  code: string;
  name: string;
  kind: SourceSystemKind;
  /** A pattern the codes of this system must match (an organization knows how its own codes look); null: any code up to the length limit. */
  codePattern: string | null;
}

export const isSourceSystemKind = (value: unknown): value is SourceSystemKind => typeof value === 'string' && (SOURCE_SYSTEM_KINDS as readonly string[]).includes(value);

/** A pattern is accepted only when it compiles and is short; the check is anchored by the caller. */
function patternOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) throw invalid('code_pattern');
  try {
    new RegExp(value);
  } catch {
    throw invalid('code_pattern');
  }
  // Nested quantifiers are the shape of a catastrophic pattern; an organization's code format never needs them.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(value)) throw invalid('code_pattern');
  return value;
}

export function sourceSystemRequestOf(body: Readonly<Record<string, unknown>>): SourceSystemRequest {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!SYSTEM_CODE.test(code) || RESERVED_SOURCE_SYSTEMS.includes(code)) throw invalid('code');
  if (!isSourceSystemKind(body.kind)) throw invalid('kind');
  return { code, name: textOf(body.name, 'name', MACHINE_NAME_MAX), kind: body.kind, codePattern: patternOf(body.code_pattern) };
}

export interface ProjectCodeRequest {
  sourceSystem: string;
  ourCode: string;
  externalCode: string;
  validFrom: string | null;
  validUntil: string | null;
}

/** The request to map a project to its code in another system: our project code, the system, their code, the days it holds. */
export function projectCodeRequestOf(body: Readonly<Record<string, unknown>>): ProjectCodeRequest {
  const sourceSystem = typeof body.source_system === 'string' ? body.source_system.trim() : '';
  if (!SYSTEM_CODE.test(sourceSystem) || RESERVED_SOURCE_SYSTEMS.includes(sourceSystem)) throw invalid('source_system');
  const validFrom = body.valid_from === undefined || body.valid_from === null ? null : dayOf(body.valid_from, 'valid_from');
  const validUntil = body.valid_until === undefined || body.valid_until === null ? null : dayOf(body.valid_until, 'valid_until');
  if (validFrom !== null && validUntil !== null && validUntil <= validFrom) throw invalid('valid_until');
  return { sourceSystem, ourCode: textOf(body.our_code, 'our_code', 100), externalCode: textOf(body.external_code, 'external_code', 100), validFrom, validUntil };
}

/** Whether a code of a system fits the format the system declared; a system without a pattern accepts any code. */
export function externalCodeFits(system: { codePattern: string | null }, code: string): boolean {
  if (system.codePattern === null) return true;
  return new RegExp(`^(?:${system.codePattern})$`).test(code);
}

/** Throws 422 `VALIDATION_FAILED` on `external_code` when the code does not fit the format of its system. */
export function assertExternalCodeFits(system: { codePattern: string | null }, code: string): void {
  if (!externalCodeFits(system, code)) throw invalid('external_code');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Logins of BI tools.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const BI_READER_STATUSES = ['ACTIVE', 'SUSPENDED', 'RETIRED'] as const;
export type BiReaderStatus = (typeof BI_READER_STATUSES)[number];
export type BiReaderMove = 'SUSPEND' | 'REACTIVATE' | 'RETIRE';

export const BI_READER_MOVES: Readonly<Record<BiReaderMove, { from: readonly BiReaderStatus[]; to: BiReaderStatus }>> = {
  SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED' },
  REACTIVATE: { from: ['SUSPENDED'], to: 'ACTIVE' },
  RETIRE: { from: ['ACTIVE', 'SUSPENDED'], to: 'RETIRED' },
};

export const isBiReaderMove = (value: unknown): value is BiReaderMove => typeof value === 'string' && Object.hasOwn(BI_READER_MOVES, value);

export function biReaderMove(reader: { status: BiReaderStatus }, step: { move: BiReaderMove; reason: unknown }): { to: BiReaderStatus; reason: string } {
  const edge = BI_READER_MOVES[step.move];
  if (edge === undefined) throw invalid('move');
  if (!edge.from.includes(reader.status)) throw new DomainError('BI_READER_STATE_INVALID', 409, 'status');
  return { to: edge.to, reason: egpReasonOf(step.reason) };
}

export const BI_CONNECTION_LIMIT_MAX = 20;
export const BI_CONNECTION_LIMIT_DEFAULT = 5;
export const BI_STATEMENT_TIMEOUT_SECONDS = 60;

export interface BiReaderRequest {
  name: string;
  tool: string | null;
  connectionLimit: number;
}

/** The request for a login of a BI tool. One login is one tool of one tenant; the datasets it can read are the ones switched on for the tenant. */
export function biReaderRequestOf(body: Readonly<Record<string, unknown>>): BiReaderRequest {
  const limit = body.connection_limit === undefined || body.connection_limit === null ? BI_CONNECTION_LIMIT_DEFAULT : body.connection_limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > BI_CONNECTION_LIMIT_MAX) throw invalid('connection_limit');
  return {
    name: textOf(body.name, 'name', MACHINE_NAME_MAX),
    tool: body.tool === undefined || body.tool === null ? null : textOf(body.tool, 'tool', 60),
    connectionLimit: limit,
  };
}

const LOGIN_NAME = /^machvon_bi_[0-9a-f]{12}$/;

/** The database login of a reader: a fixed prefix and twelve characters of its id, so the name tells nothing about the tenant and cannot be chosen by a caller. */
export function biLoginName(readerId: string): string {
  const hex = readerId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw invalid('reader');
  return `machvon_bi_${hex.slice(0, 12)}`;
}

export const isBiLoginName = (value: unknown): value is string => typeof value === 'string' && LOGIN_NAME.test(value);
