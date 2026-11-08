import { DomainError } from './errors.ts';

/**
 * The public portal (G4-9, practice P16 and P13): a read-only surface that shows the public only a set of fields that the tenant allowed. This file is the whole of the rule and has no I/O:
 *   - `PORTAL_FIELDS` is the closed catalogue of what can ever be shown (nothing in it names a person, a bank account, an internal id, an audit finding or a red flag); the allow-list of a tenant is a subset of it;
 *   - `publishableProject` says whether a project may be shown at all (its classification is PUBLIC and it is past the idea stage and not rejected);
 *   - `projectPortalRecord` cuts a project down to its allowed fields; the cut is applied when a record is published and again when it is read, so a record that was stored with more than the allow-list holds today
 *     still shows only what the list allows today;
 *   - `oc4idsProject`, `oc4idsPackage` and `validateOc4idsPackage` write the records in the Open Contracting Data Standard for Infrastructure and check the result against the required fields of the standard, offline.
 * The allow-list, the page size and the rate limit are the governance rule `PUBLIC_PORTAL_RULE` (UNVERIFIED). The codelists and the required fields of OC4IDS below are written from the standard as known when this lane was
 * built, with no network: each is marked UNVERIFIED and is data, so a diff with the schema file of the standard is a change of one list.
 */

export const PORTAL_RULE_TYPE = 'PUBLIC_PORTAL_RULE';

export const PORTAL_FIELDS = ['project_code', 'title', 'summary', 'status', 'project_group', 'sector', 'project_type', 'purpose', 'start_year', 'end_year', 'budget_vnd', 'authority_name', 'progress_pct', 'disbursed_vnd', 'updated_on'] as const;
export type PortalField = (typeof PORTAL_FIELDS)[number];

/** What a tenant shows when it has made no choice: no money that moved and no progress figure, which a tenant adds only on purpose. */
export const PORTAL_DEFAULT_FIELDS: readonly PortalField[] = ['project_code', 'title', 'summary', 'status', 'project_group', 'sector', 'project_type', 'purpose', 'start_year', 'end_year', 'budget_vnd', 'authority_name', 'updated_on'];

export interface PortalPolicy {
  allowed_fields: PortalField[];
  /** Requests a client may make in a minute of one portal. */
  rate_per_minute: number;
  page_size_max: number;
}

export const portalDefaults = (): PortalPolicy => ({ allowed_fields: [...PORTAL_DEFAULT_FIELDS], rate_per_minute: 60, page_size_max: 100 });

export const isPortalField = (value: unknown): value is PortalField => typeof value === 'string' && (PORTAL_FIELDS as readonly string[]).includes(value);

export function portalPolicyOf(params: Readonly<Record<string, unknown>>): PortalPolicy {
  const fields = params.allowed_fields;
  if (!Array.isArray(fields) || fields.length < 1 || !fields.every(isPortalField) || new Set(fields).size !== fields.length) throw new DomainError('VALIDATION_FAILED', 422, 'allowed_fields');
  const rate = params.rate_per_minute;
  const page = params.page_size_max;
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1 || rate > 6000) throw new DomainError('VALIDATION_FAILED', 422, 'rate_per_minute');
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 500) throw new DomainError('VALIDATION_FAILED', 422, 'page_size_max');
  // The identifying field of a record is always shown: a portal that hides the code of every project cannot be read.
  return { allowed_fields: [...new Set<PortalField>(['project_code', ...(fields as PortalField[])])], rate_per_minute: rate, page_size_max: page };
}

/** A slug of a portal in a URL: lower case letters, digits and hyphens, 3 to 40 characters. */
export const PORTAL_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
export const assertPortalSlug = (slug: string): void => {
  if (!PORTAL_SLUG.test(slug) || slug.includes('--')) throw new DomainError('VALIDATION_FAILED', 422, 'slug');
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What a project may show.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const PORTAL_PURPOSES = ['social', 'economic', 'environmental', 'other'] as const;
export const PORTAL_SECTORS = ['transport', 'transport.road', 'transport.rail', 'transport.air', 'transport.water', 'energy', 'water', 'sanitation', 'health', 'education', 'housing', 'agriculture', 'telecommunications', 'urban', 'environment', 'other'] as const;
export const PORTAL_PROJECT_TYPES = ['construction', 'expansion', 'maintenance', 'rehabilitation', 'replacement'] as const;

export interface PortalProjectFacts {
  code: string;
  name: string;
  status: string;
  classification: string;
  projectGroup: string | null;
  totalInvestmentVnd: string;
  startYear: number | null;
  endYear: number | null;
  authorityName: string | null;
  updatedOn: string;
  progressPct: number | null;
  disbursedVnd: string | null;
}

export interface PublisherInput {
  summary: string;
  sector: string;
  projectType: string;
  purpose: string;
}

const HIDDEN_STATUSES: readonly string[] = ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED'];

/** A project is shown only when its own classification says PUBLIC and it is past the idea stage; CONFIDENTIAL and INTERNAL never are, whatever the publisher wishes. */
export function publishableProject(facts: Pick<PortalProjectFacts, 'classification' | 'status'>): boolean {
  return facts.classification === 'PUBLIC' && !HIDDEN_STATUSES.includes(facts.status);
}

export function assertPortalPublishable(facts: Pick<PortalProjectFacts, 'classification' | 'status'>): void {
  if (!publishableProject(facts)) throw new DomainError('PORTAL_NOT_PUBLISHABLE', 422, 'project');
}

/** The words the publisher wrote must be plain text of a sensible size, with no markup and no way to carry a link into the page. */
export function assertPublisherInput(input: PublisherInput): void {
  const summary = input.summary.trim();
  if (summary !== input.summary || summary.length < 10 || summary.length > 2000 || /[<>]/.test(summary)) throw new DomainError('VALIDATION_FAILED', 422, 'summary');
  if (!(PORTAL_SECTORS as readonly string[]).includes(input.sector)) throw new DomainError('VALIDATION_FAILED', 422, 'sector');
  if (!(PORTAL_PROJECT_TYPES as readonly string[]).includes(input.projectType)) throw new DomainError('VALIDATION_FAILED', 422, 'project_type');
  if (!(PORTAL_PURPOSES as readonly string[]).includes(input.purpose)) throw new DomainError('VALIDATION_FAILED', 422, 'purpose');
}

export type PortalRecord = Partial<Record<PortalField, string | number | null>>;

/** The value of every field of the catalogue for a project; the allow-list then picks. Money is exact text of whole dong. */
function allFields(facts: PortalProjectFacts, input: PublisherInput): Record<PortalField, string | number | null> {
  return {
    project_code: facts.code,
    title: facts.name,
    summary: input.summary,
    status: facts.status,
    project_group: facts.projectGroup,
    sector: input.sector,
    project_type: input.projectType,
    purpose: input.purpose,
    start_year: facts.startYear,
    end_year: facts.endYear,
    budget_vnd: facts.totalInvestmentVnd,
    authority_name: facts.authorityName,
    progress_pct: facts.progressPct,
    disbursed_vnd: facts.disbursedVnd,
    updated_on: facts.updatedOn,
  };
}

/** The record of a project cut to the allowed fields: a field that is not allowed is absent, not null. */
export function projectPortalRecord(facts: PortalProjectFacts, input: PublisherInput, allowed: readonly PortalField[]): PortalRecord {
  assertPortalPublishable(facts);
  assertPublisherInput(input);
  return cutToAllowed(allFields(facts, input), allowed);
}

/** The cut applied to a stored record (output side): keys that are not in the catalogue or not allowed today are dropped, and a value of the wrong shape is dropped with them. */
export function cutToAllowed(record: Readonly<Record<string, unknown>>, allowed: readonly PortalField[]): PortalRecord {
  const out: PortalRecord = {};
  for (const field of PORTAL_FIELDS) {
    if (!allowed.includes(field)) continue;
    const value = record[field];
    if (value === undefined) continue;
    if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[field] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// OC4IDS.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const OC4IDS_VERSION = '0.9';
/** Where these lists come from, and that they were not diffed with the schema file of the standard (no network when the lane was built). */
export const OC4IDS_LISTS_STATUS = { source: 'OC4IDS project schema and codelists, as known offline', legalStatus: 'UNVERIFIED' } as const;
/** The fields that a project of an OC4IDS package must have. */
export const OC4IDS_PROJECT_REQUIRED = ['id', 'updated', 'title', 'description', 'status', 'period', 'sector', 'purpose', 'type', 'budget', 'publicAuthority'] as const;
export const OC4IDS_STATUS_CODES = ['identification', 'preparation', 'implementation', 'completion', 'completed', 'cancelled'] as const;
export const OC4IDS_PACKAGE_REQUIRED = ['version', 'publisher', 'license', 'publicationPolicy', 'publishedDate', 'projects'] as const;

const STATUS_MAP: Readonly<Record<string, (typeof OC4IDS_STATUS_CODES)[number]>> = {
  PIPELINE: 'identification',
  BUDGETED: 'preparation',
  IMPLEMENTATION: 'implementation',
  SUSPENDED: 'implementation',
  COMPLETED: 'completion',
  SETTLED: 'completed',
  CLOSED: 'completed',
};

export interface Oc4idsProject {
  id: string;
  updated: string;
  title?: string;
  description?: string;
  status?: string;
  period?: { startDate?: string; endDate?: string };
  sector?: string[];
  purpose?: string;
  type?: string;
  budget?: { amount: { amount: string; currency: 'VND' } };
  publicAuthority?: { name: string };
  [key: string]: unknown;
}

export interface Oc4idsPublisher {
  name: string;
  uri?: string;
}

/**
 * One project in OC4IDS. A field the allow-list took away, or that the project has no value for, is left out and not invented, so that the check of the required fields says exactly what the tenant chose not to show.
 */
export function oc4idsProject(record: PortalRecord, idPrefix: string): Oc4idsProject {
  const code = record.project_code;
  if (typeof code !== 'string' || code === '') throw new DomainError('VALIDATION_FAILED', 422, 'project_code');
  const updated = typeof record.updated_on === 'string' ? `${record.updated_on}T00:00:00Z` : '1970-01-01T00:00:00Z';
  const project: Oc4idsProject = { id: `${idPrefix}-${code}`, updated };
  if (typeof record.title === 'string') project.title = record.title;
  if (typeof record.summary === 'string') project.description = record.summary;
  if (typeof record.status === 'string') {
    const mapped = STATUS_MAP[record.status];
    if (mapped !== undefined) project.status = mapped;
  }
  const start = record.start_year;
  const end = record.end_year;
  if (typeof start === 'number' || typeof end === 'number') {
    project.period = {};
    if (typeof start === 'number') project.period.startDate = `${start}-01-01`;
    if (typeof end === 'number') project.period.endDate = `${end}-12-31`;
  }
  if (typeof record.sector === 'string') project.sector = [record.sector];
  if (typeof record.purpose === 'string') project.purpose = record.purpose;
  if (typeof record.project_type === 'string') project.type = record.project_type;
  if (typeof record.budget_vnd === 'string') project.budget = { amount: { amount: record.budget_vnd, currency: 'VND' } };
  if (typeof record.authority_name === 'string' && record.authority_name !== '') project.publicAuthority = { name: record.authority_name };
  return project;
}

export interface Oc4idsPackage {
  version: string;
  publisher: Oc4idsPublisher;
  license: string;
  publicationPolicy: string;
  publishedDate: string;
  projects: Oc4idsProject[];
}

export function oc4idsPackage(input: { records: readonly PortalRecord[]; idPrefix: string; publisher: Oc4idsPublisher; license: string; publicationPolicy: string; publishedAt: Date }): Oc4idsPackage {
  return {
    version: OC4IDS_VERSION,
    publisher: input.publisher,
    license: input.license,
    publicationPolicy: input.publicationPolicy,
    publishedDate: input.publishedAt.toISOString(),
    projects: input.records.map((record) => oc4idsProject(record, input.idPrefix)),
  };
}

export interface Oc4idsIssue {
  /** The path of the missing or wrong field, `projects[2].sector`. */
  path: string;
  problem: 'MISSING' | 'WRONG_TYPE' | 'NOT_IN_CODELIST';
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The problems of a package against the required fields and the codelists: an empty list is a package that holds what the standard requires. It never fetches anything. */
export function validateOc4idsPackage(input: unknown): Oc4idsIssue[] {
  const issues: Oc4idsIssue[] = [];
  if (!isObject(input)) return [{ path: '$', problem: 'WRONG_TYPE' }];
  for (const key of OC4IDS_PACKAGE_REQUIRED) if (input[key] === undefined) issues.push({ path: key, problem: 'MISSING' });
  if (isObject(input.publisher) && !isText(input.publisher.name)) issues.push({ path: 'publisher.name', problem: 'MISSING' });
  if (input.publishedDate !== undefined && !(typeof input.publishedDate === 'string' && DATE_TIME.test(input.publishedDate))) issues.push({ path: 'publishedDate', problem: 'WRONG_TYPE' });
  const projects = input.projects;
  if (projects === undefined) return issues;
  if (!Array.isArray(projects)) return [...issues, { path: 'projects', problem: 'WRONG_TYPE' }];
  projects.forEach((project, index) => {
    const at = `projects[${index}]`;
    if (!isObject(project)) {
      issues.push({ path: at, problem: 'WRONG_TYPE' });
      return;
    }
    for (const key of OC4IDS_PROJECT_REQUIRED) if (project[key] === undefined) issues.push({ path: `${at}.${key}`, problem: 'MISSING' });
    if (project.updated !== undefined && !(typeof project.updated === 'string' && DATE_TIME.test(project.updated))) issues.push({ path: `${at}.updated`, problem: 'WRONG_TYPE' });
    for (const key of ['id', 'title', 'description', 'purpose', 'type'] as const) if (project[key] !== undefined && !isText(project[key])) issues.push({ path: `${at}.${key}`, problem: 'WRONG_TYPE' });
    if (project.status !== undefined && !(OC4IDS_STATUS_CODES as readonly string[]).includes(project.status as string)) issues.push({ path: `${at}.status`, problem: 'NOT_IN_CODELIST' });
    if (project.sector !== undefined && !(Array.isArray(project.sector) && project.sector.length > 0 && project.sector.every((sector) => typeof sector === 'string' && (PORTAL_SECTORS as readonly string[]).includes(sector)))) issues.push({ path: `${at}.sector`, problem: 'NOT_IN_CODELIST' });
    if (project.period !== undefined) {
      const period = project.period;
      if (!isObject(period)) issues.push({ path: `${at}.period`, problem: 'WRONG_TYPE' });
      else {
        for (const key of ['startDate', 'endDate'] as const) {
          if (period[key] === undefined) issues.push({ path: `${at}.period.${key}`, problem: 'MISSING' });
          else if (!(typeof period[key] === 'string' && DATE.test(period[key] as string))) issues.push({ path: `${at}.period.${key}`, problem: 'WRONG_TYPE' });
        }
      }
    }
    if (project.budget !== undefined) {
      const amount = isObject(project.budget) && isObject(project.budget.amount) ? project.budget.amount : undefined;
      if (amount === undefined || !(typeof amount.amount === 'string' && /^\d+$/.test(amount.amount)) || amount.currency !== 'VND') issues.push({ path: `${at}.budget.amount`, problem: 'WRONG_TYPE' });
    }
    if (project.publicAuthority !== undefined && !(isObject(project.publicAuthority) && isText(project.publicAuthority.name))) issues.push({ path: `${at}.publicAuthority.name`, problem: 'MISSING' });
  });
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A rate limit that holds no identity.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface KeyedRateLimiterOptions {
  limit: number;
  windowSeconds: number;
  /** The most keys held at once; when the table is full the oldest windows go first, so the table cannot grow with the number of clients. */
  maxKeys?: number;
  now?: () => number;
}

export interface KeyedVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * A fixed-window limiter over opaque keys, held in memory only. The key is whatever the caller derives (for the public portal and the anonymous channel: a hash of the client address with a secret that rotates, never
 * the address) and nothing here writes it anywhere, so the limiter can protect a channel that promises to keep no identity.
 */
export class KeyedRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: KeyedRateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('rate limit must be a positive integer');
    if (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0) throw new RangeError('rate limit window must be positive');
    this.limit = options.limit;
    this.windowMs = options.windowSeconds * 1000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): KeyedVerdict {
    const now = this.now();
    for (const [name, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(name);
    const current = this.windows.get(key);
    if (current === undefined && this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done !== true) this.windows.delete(oldest.value);
    }
    const window = current ?? { start: now, count: 0 };
    this.windows.set(key, window);
    if (window.count >= this.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) };
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  size(): number {
    return this.windows.size;
  }
}
