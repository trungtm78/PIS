import { ApiError } from '@machvon/api-client';
import type { Tone } from '../../ui';

export const CERTIFY_PERMISSION = 'analytics.certify';
export const CERTIFICATION_PATH = '/bi/bi-19';
export const REGISTER_PATH = '/bi/bi-20';
/** The publication flow of BI (BI-11): the way a metric is certified, by a request someone else decides. */
export const PUBLICATION_PATH = '/bi/bi-11';
/** Sending back and making obsolete need words: the server refuses a note shorter than this. */
export const NOTE_MIN = 5;

export const CERT_STATUSES = ['DRAFT', 'CONFIRMED', 'CERTIFIED', 'OBSOLETE'] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];
export type CertSubject = 'KPI' | 'DATASET';
export const CERT_TABS = ['KPI', 'DATASET', 'METRIC'] as const;
export type CertTab = (typeof CERT_TABS)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const statusOf = (value: unknown): CertStatus | undefined => (typeof value === 'string' && (CERT_STATUSES as readonly string[]).includes(value) ? (value as CertStatus) : undefined);

export interface Person {
  id: string;
  name: string;
}

function personOf(raw: unknown): Person | null {
  const row = asRecord(raw);
  const id = text(row?.id);
  const name = text(row?.name);
  return id === undefined || name === undefined ? null : { id, name };
}

/** What the four certification fields of a KPI and of a dataset share: the state in force, who moved it and when. */
export interface CertState {
  status: CertStatus;
  version: number;
  /** Who gave the certificate: the platform (the repository review) or the tenant. */
  origin: 'PLATFORM' | 'TENANT';
  certifiedBy: Person | null;
  confirmedBy: Person | null;
  note: string | null;
  at: string | null;
}

export interface KpiCertification extends CertState {
  subject: 'KPI';
  key: string;
  code: string;
  name: string;
  unverified: boolean;
  definitionOrigin: 'RULE' | 'DEFAULT';
  /** Version 0 is the default of the platform, certified by the review of the repository: it is not moved here. */
  builtIn: boolean;
}

export interface DatasetCertification extends CertState {
  subject: 'DATASET';
  key: string;
  code: string;
  title: string;
  datasetStatus: string;
  /** The version of the lapsed certificate when the definition changed since. */
  lastCertifiedVersion: number | null;
}

export interface MetricCertification {
  key: string;
  code: string;
  revision: number;
  status: CertStatus;
  registryStatus: string;
  origin: string;
  certifiedBy: Person | null;
  at: string | null;
}

export type Certifiable = KpiCertification | DatasetCertification;

export interface Certifications {
  asOf: string;
  kpis: KpiCertification[];
  datasets: DatasetCertification[];
  metrics: MetricCertification[];
  /** Entries of the answer that lacked what the screen needs: counted and said, never guessed. */
  skipped: number;
}

function stateOf(row: Raw): CertState | undefined {
  const status = statusOf(row.status);
  const version = whole(row.version);
  if (status === undefined || version === undefined) return undefined;
  return {
    status,
    version,
    origin: row.origin === 'PLATFORM' ? 'PLATFORM' : 'TENANT',
    certifiedBy: personOf(row.certified_by),
    confirmedBy: personOf(row.confirmed_by),
    note: nullableText(row.note),
    at: nullableText(row.at),
  };
}

function toKpi(raw: unknown): KpiCertification | undefined {
  const row = asRecord(raw);
  const code = text(row?.code);
  const state = row === undefined ? undefined : stateOf(row);
  if (row === undefined || code === undefined || state === undefined) return undefined;
  return { subject: 'KPI', key: code, code, name: text(row.name) ?? code, unverified: row.unverified === true, definitionOrigin: row.definition_origin === 'RULE' ? 'RULE' : 'DEFAULT', builtIn: state.version === 0, ...state };
}

function toDatasetCertification(raw: unknown): DatasetCertification | undefined {
  const row = asRecord(raw);
  const id = text(row?.dataset_id);
  const code = text(row?.code);
  const state = row === undefined ? undefined : stateOf(row);
  if (row === undefined || id === undefined || code === undefined || state === undefined) return undefined;
  return { subject: 'DATASET', key: id, code, title: text(row.title) ?? code, datasetStatus: text(row.dataset_status) ?? '', lastCertifiedVersion: whole(row.last_certified_version) ?? null, ...state };
}

function toMetricCertification(raw: unknown): MetricCertification | undefined {
  const row = asRecord(raw);
  const id = text(row?.metric_id);
  const code = text(row?.code);
  const status = statusOf(row?.status);
  const revision = whole(row?.revision);
  if (row === undefined || id === undefined || code === undefined || status === undefined || revision === undefined) return undefined;
  return { key: id, code, revision, status, registryStatus: text(row.registry_status) ?? '', origin: text(row.origin) ?? '', certifiedBy: personOf(row.certified_by), at: nullableText(row.at) };
}

/** The answer of `GET /bi/certifications`; an answer without the three lists is not an answer (the screen shows an error with retry, never an empty list). */
export function toCertifications(raw: unknown): Certifications | undefined {
  const row = asRecord(raw);
  if (row === undefined || !Array.isArray(row.kpis) || !Array.isArray(row.datasets) || !Array.isArray(row.metrics)) return undefined;
  const kpis = row.kpis.map(toKpi);
  const datasets = row.datasets.map(toDatasetCertification);
  const metrics = row.metrics.map(toMetricCertification);
  const keep = <T>(items: Array<T | undefined>): T[] => items.filter((item): item is T => item !== undefined);
  return {
    asOf: text(row.as_of) ?? '',
    kpis: keep(kpis),
    datasets: keep(datasets),
    metrics: keep(metrics),
    skipped: [...kpis, ...datasets, ...metrics].filter((item) => item === undefined).length,
  };
}

// ---- the moves --------------------------------------------------------------------------------------------------------------------------

export const MOVES = ['CONFIRM', 'CERTIFY', 'RETURN', 'OBSOLETE'] as const;
export type Move = (typeof MOVES)[number];
export const MOVE_TARGET: Readonly<Record<Move, CertStatus>> = { CONFIRM: 'CONFIRMED', CERTIFY: 'CERTIFIED', RETURN: 'DRAFT', OBSOLETE: 'OBSOLETE' };
/** Sending back and making obsolete are explained in words (at least NOTE_MIN characters); confirming and certifying may carry a note. */
export const MOVE_NEEDS_NOTE: Readonly<Record<Move, boolean>> = { CONFIRM: false, CERTIFY: false, RETURN: true, OBSOLETE: true };

/**
 * The moves the row may be offered, by the rules the server keeps: Draft is confirmed; an Confirmed is certified by someone other than who confirmed it, or sent back to Draft; an Certified becomes Outdated;
 * nothing leaves Outdated; the built-in default of the platform is not moved. The server judges again (a refusal is shown in words).
 */
export function legalMoves(row: Certifiable, me: string | undefined): Move[] {
  if (row.subject === 'KPI' && row.builtIn) return [];
  switch (row.status) {
    case 'DRAFT':
      return ['CONFIRM'];
    case 'CONFIRMED':
      return row.confirmedBy !== null && me !== undefined && row.confirmedBy.id === me ? ['RETURN'] : ['CERTIFY', 'RETURN'];
    case 'CERTIFIED':
      return ['OBSOLETE'];
    case 'OBSOLETE':
      return [];
  }
}

/** A dataset whose definition moved on from a certified version needs a new certificate. */
export const needsRecertification = (row: DatasetCertification): boolean => row.lastCertifiedVersion !== null && row.status !== 'CERTIFIED';

export interface TransitionInput {
  row: Certifiable;
  move: Move;
  note: string;
}

export const noteProblem = (move: Move, note: string): 'tooShort' | undefined => (MOVE_NEEDS_NOTE[move] && note.trim().length < NOTE_MIN ? 'tooShort' : undefined);

export function transitionBody(input: TransitionInput): { subject: CertSubject; key: string; version: number; to: CertStatus; note?: string } {
  const note = input.note.trim();
  return { subject: input.row.subject, key: input.row.key, version: input.row.version, to: MOVE_TARGET[input.move], ...(note === '' ? {} : { note }) };
}

export type CertReason = 'selfApproval' | 'stage' | 'notFound' | 'invalid' | 'denied' | 'session' | 'general';

const REASON_BY_CODE: Readonly<Record<string, CertReason>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  STAGE_TRANSITION_DENIED: 'stage',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'invalid',
  SESSION_EXPIRED: 'session',
};

/** What the refusal of the server is, in the words the screen has for it. */
export function describeCertProblem(error: unknown): { reason: CertReason; field: string } {
  if (!(error instanceof ApiError)) return { reason: 'general', field: '' };
  const known = REASON_BY_CODE[error.code];
  const field = typeof error.detail === 'string' ? error.detail : '';
  if (known !== undefined) return { reason: known, field };
  return { reason: error.status === 403 ? 'denied' : 'general', field };
}

export const statusTone = (status: CertStatus): Tone => (status === 'CERTIFIED' ? 'success' : status === 'CONFIRMED' ? 'info' : status === 'OBSOLETE' ? 'warning' : 'neutral');

// ---- the log ------------------------------------------------------------------------------------------------------------------------------

export interface CertLine {
  version: number;
  seq: number;
  status: CertStatus;
  actor: Person | null;
  confirmedBy: Person | null;
  note: string | null;
  at: string;
}

/** The lines of a certification log, the newest first (by version then by sequence); a line that lacks what the screen needs is counted, not guessed. */
export function toCertLog(raw: unknown): { lines: CertLine[]; skipped: number } | undefined {
  const row = asRecord(raw);
  if (row === undefined || !Array.isArray(row.lines)) return undefined;
  const lines: CertLine[] = [];
  let skipped = 0;
  for (const item of row.lines) {
    const line = asRecord(item);
    const status = statusOf(line?.status);
    const version = whole(line?.version);
    const seq = whole(line?.seq);
    if (line === undefined || status === undefined || version === undefined || seq === undefined) {
      skipped += 1;
      continue;
    }
    lines.push({ version, seq, status, actor: personOf(line.actor), confirmedBy: personOf(line.confirmed_by), note: nullableText(line.note), at: text(line.at) ?? '' });
  }
  lines.sort((a, b) => b.version - a.version || b.seq - a.seq);
  return { lines, skipped };
}

/** The day of a stamp as people write it in Vietnam (`2026-11-08T…` becomes `08/11/2026`); a stamp that is not a date is shown as it is. */
export function dayOf(stamp: string | null): string {
  if (stamp === null) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
  return match === null ? stamp : `${match[3]}/${match[2]}/${match[1]}`;
}
