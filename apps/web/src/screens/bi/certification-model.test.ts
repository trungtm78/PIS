import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { dayOf, describeCertProblem, legalMoves, needsRecertification, noteProblem, toCertLog, toCertifications, transitionBody } from './certification-model';
import type { DatasetCertification, KpiCertification } from './certification-model';

const ME = 'm-me';
const OTHER = 'm-other';
const person = (id: string, name = id) => ({ id, name });
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });

const rawKpi = (overrides: Record<string, unknown> = {}) => ({
  code: 'DISBURSEMENT_RATE_PM',
  name: 'Tỷ lệ giải ngân PM',
  unverified: true,
  definition_origin: 'DEFAULT',
  status: 'DRAFT',
  version: 3,
  origin: 'TENANT',
  certified_by: null,
  confirmed_by: null,
  note: null,
  at: null,
  ...overrides,
});
const rawDataset = (overrides: Record<string, unknown> = {}) => ({
  dataset_id: '00000000-0000-4000-8000-0000000000d1',
  code: 'DS-DISB',
  title: 'Giải ngân',
  dataset_status: 'ACTIVE',
  last_certified_version: null,
  status: 'DRAFT',
  version: 2,
  origin: 'TENANT',
  certified_by: null,
  confirmed_by: null,
  note: null,
  at: null,
  ...overrides,
});
const rawMetric = (overrides: Record<string, unknown> = {}) => ({ metric_id: 'mm1', code: 'disbursed', revision: 2, status: 'CERTIFIED', registry_status: 'CERTIFIED', origin: 'PLATFORM_CODE', certified_by: person('p1', 'Người duyệt'), at: '2026-11-01T01:00:00.000Z', ...overrides });

const kpi = (overrides: Partial<KpiCertification> = {}): KpiCertification => ({
  subject: 'KPI',
  key: 'K1',
  code: 'K1',
  name: 'K',
  unverified: false,
  definitionOrigin: 'RULE',
  builtIn: false,
  status: 'DRAFT',
  version: 1,
  origin: 'TENANT',
  certifiedBy: null,
  confirmedBy: null,
  note: null,
  at: null,
  ...overrides,
});
const dataset = (overrides: Partial<DatasetCertification> = {}): DatasetCertification => ({
  subject: 'DATASET',
  key: 'd1',
  code: 'DS',
  title: 'T',
  datasetStatus: 'ACTIVE',
  lastCertifiedVersion: null,
  status: 'DRAFT',
  version: 1,
  origin: 'TENANT',
  certifiedBy: null,
  confirmedBy: null,
  note: null,
  at: null,
  ...overrides,
});

describe('toCertifications', () => {
  it('reads the three lists and marks version 0 of a KPI as the built-in default', () => {
    const answer = toCertifications({ as_of: '2026-11-08', kpis: [rawKpi(), rawKpi({ code: 'OPEN_WARNINGS', version: 0, status: 'CERTIFIED', origin: 'PLATFORM', unverified: false })], datasets: [rawDataset({ last_certified_version: 4 })], metrics: [rawMetric()] });
    expect(answer?.asOf).toBe('2026-11-08');
    expect(answer?.kpis.map((row) => [row.code, row.builtIn, row.unverified, row.status])).toEqual([
      ['DISBURSEMENT_RATE_PM', false, true, 'DRAFT'],
      ['OPEN_WARNINGS', true, false, 'CERTIFIED'],
    ]);
    expect(answer?.datasets[0]).toMatchObject({ key: '00000000-0000-4000-8000-0000000000d1', code: 'DS-DISB', lastCertifiedVersion: 4, status: 'DRAFT' });
    expect(answer?.metrics[0]).toMatchObject({ key: 'mm1', status: 'CERTIFIED', certifiedBy: { name: 'Người duyệt' } });
    expect(answer?.skipped).toBe(0);
  });

  it('is not an answer without the three lists: a read that came back wrong is an error, never an empty list', () => {
    expect(toCertifications(undefined)).toBeUndefined();
    expect(toCertifications({ kpis: [], datasets: [] })).toBeUndefined();
    expect(toCertifications({ kpis: [], datasets: [], metrics: 'x' })).toBeUndefined();
  });

  it('counts the entries that lack what the screen needs instead of guessing them', () => {
    const answer = toCertifications({ kpis: [rawKpi({ status: 'WEIRD' }), rawKpi()], datasets: [rawDataset({ dataset_id: undefined })], metrics: [rawMetric({ revision: -1 })] });
    expect(answer?.kpis.length).toBe(1);
    expect(answer?.datasets.length).toBe(0);
    expect(answer?.metrics.length).toBe(0);
    expect(answer?.skipped).toBe(3);
  });
});

describe('legalMoves', () => {
  it('offers only the legal next moves', () => {
    expect(legalMoves(kpi({ status: 'DRAFT' }), ME)).toEqual(['CONFIRM']);
    expect(legalMoves(kpi({ status: 'CONFIRMED', confirmedBy: person(OTHER) }), ME)).toEqual(['CERTIFY', 'RETURN']);
    expect(legalMoves(kpi({ status: 'CERTIFIED' }), ME)).toEqual(['OBSOLETE']);
    expect(legalMoves(kpi({ status: 'OBSOLETE' }), ME)).toEqual([]);
    expect(legalMoves(dataset({ status: 'DRAFT' }), ME)).toEqual(['CONFIRM']);
  });

  it('does not offer "Chứng nhận" to the person who confirmed, only sending back', () => {
    expect(legalMoves(kpi({ status: 'CONFIRMED', confirmedBy: person(ME) }), ME)).toEqual(['RETURN']);
    expect(legalMoves(dataset({ status: 'CONFIRMED', confirmedBy: person(ME) }), ME)).toEqual(['RETURN']);
  });

  it('does not move a built-in KPI of the platform, whatever its state', () => {
    for (const status of ['DRAFT', 'CONFIRMED', 'CERTIFIED', 'OBSOLETE'] as const) expect(legalMoves(kpi({ builtIn: true, version: 0, status }), ME)).toEqual([]);
  });
});

describe('transition body and notes', () => {
  it('sends the subject, key, the version in force and the target state; the note only when there is one', () => {
    expect(transitionBody({ row: kpi({ version: 3 }), move: 'CONFIRM', note: '  ' })).toEqual({ subject: 'KPI', key: 'K1', version: 3, to: 'CONFIRMED' });
    expect(transitionBody({ row: dataset({ version: 2 }), move: 'OBSOLETE', note: ' Đã thay bằng bản mới ' })).toEqual({ subject: 'DATASET', key: 'd1', version: 2, to: 'OBSOLETE', note: 'Đã thay bằng bản mới' });
    expect(transitionBody({ row: kpi(), move: 'RETURN', note: 'sai số' }).to).toBe('DRAFT');
    expect(transitionBody({ row: kpi(), move: 'CERTIFY', note: '' }).to).toBe('CERTIFIED');
  });

  it('asks for at least five characters when sending back or making obsolete, never when confirming or certifying', () => {
    expect(noteProblem('RETURN', 'abcd')).toBe('tooShort');
    expect(noteProblem('RETURN', '  abcd  ')).toBe('tooShort');
    expect(noteProblem('OBSOLETE', 'abcde')).toBeUndefined();
    expect(noteProblem('CONFIRM', '')).toBeUndefined();
    expect(noteProblem('CERTIFY', '')).toBeUndefined();
  });

  it('knows a dataset that changed from a certified version and is not certified again', () => {
    expect(needsRecertification(dataset({ lastCertifiedVersion: 2, status: 'DRAFT' }))).toBe(true);
    expect(needsRecertification(dataset({ lastCertifiedVersion: 2, status: 'CERTIFIED' }))).toBe(false);
    expect(needsRecertification(dataset({ lastCertifiedVersion: null }))).toBe(false);
  });
});

describe('describeCertProblem', () => {
  it.each([
    [failure(403, 'SELF_APPROVAL_DENIED'), 'selfApproval'],
    [failure(409, 'STAGE_TRANSITION_DENIED', 'version'), 'stage'],
    [failure(404, 'RESOURCE_NOT_FOUND'), 'notFound'],
    [failure(422, 'VALIDATION_FAILED', 'note'), 'invalid'],
    [failure(403, 'FORBIDDEN'), 'denied'],
    [failure(401, 'SESSION_EXPIRED'), 'session'],
    [failure(500, 'INTERNAL_ERROR'), 'general'],
    [new Error('x'), 'general'],
  ])('says %#', (error, reason) => {
    expect(describeCertProblem(error).reason).toBe(reason);
  });

  it('keeps the field the server names', () => {
    expect(describeCertProblem(failure(422, 'VALIDATION_FAILED', 'note')).field).toBe('note');
  });
});

describe('toCertLog and dayOf', () => {
  it('reads the log newest first and counts the lines it cannot read', () => {
    const log = toCertLog({
      lines: [
        { version: 1, seq: 1, status: 'DRAFT', actor: person('a', 'A'), confirmed_by: null, note: null, at: '2026-11-01T01:00:00.000Z' },
        { version: 2, seq: 1, status: 'CONFIRMED', actor: person('b', 'B'), confirmed_by: person('b', 'B'), note: null, at: '2026-11-02T01:00:00.000Z' },
        { version: 1, seq: 2, status: 'CERTIFIED', actor: person('c', 'C'), confirmed_by: person('a', 'A'), note: 'ok', at: '2026-11-03T01:00:00.000Z' },
        { version: 'x', seq: 1, status: 'DRAFT' },
      ],
    });
    expect(log?.lines.map((line) => `${line.version}.${line.seq}`)).toEqual(['2.1', '1.2', '1.1']);
    expect(log?.skipped).toBe(1);
    expect(toCertLog({})).toBeUndefined();
  });

  it('writes a day the way it is written in Vietnam', () => {
    expect(dayOf('2026-11-08T03:00:00.000Z')).toBe('08/11/2026');
    expect(dayOf(null)).toBe('');
    expect(dayOf('soon')).toBe('soon');
  });
});
