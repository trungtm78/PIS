import { canonicalJson, sha256Hex } from './canonical-json.ts';

/**
 * The versions of a BI dataset (ST-BI-002, BI 3 F2): a dataset version is the data of one period as one frozen snapshot of its source gave it, with what the quality rules of DGV said of that snapshot.
 * The rules here are pure; the store reads the snapshot and the run.
 */
export const QUALITY_BADGES = ['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE'] as const;
export type QualityBadge = (typeof QUALITY_BADGES)[number];
export const DATASET_VERSION_STATUSES = ['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED'] as const;
export type DatasetVersionStatus = (typeof DATASET_VERSION_STATUSES)[number];

/** What the dataset builder needs of a quality run of DGV. */
export interface QualityRunFacts {
  id: string;
  status: string;
  overallResult: string | null;
  certifiedBlocked: boolean;
  quarantinedCount: number;
  /** The digest of the payload of the snapshot the run measured. */
  snapshotSha256: string | null;
}

export interface QualityOfVersion {
  badge: QualityBadge;
  runId: string | null;
  excludedQuarantineRows: number;
}

/**
 * The quality of a version. No run, a run that is still running and a run that could not be measured give `NOT_ASSESSED` with nothing linked and no row excluded: the quality of the data is not known,
 * and the screens say so instead of calling it good. A run of a snapshot whose payload is no longer the one the run measured is `STALE`: it is linked, and its quarantine does not apply to this data.
 * Otherwise the badge is the verdict of the run (a run that blocks certified figures is `FAILED`), and the rows its rules quarantined are counted as excluded.
 */
export function qualityOfVersion(run: QualityRunFacts | undefined, snapshotSha256: string | null): QualityOfVersion {
  if (run === undefined || run.status !== 'COMPLETED' || run.overallResult === null) return { badge: 'NOT_ASSESSED', runId: null, excludedQuarantineRows: 0 };
  if (run.snapshotSha256 !== null && snapshotSha256 !== null && run.snapshotSha256 !== snapshotSha256) return { badge: 'STALE', runId: run.id, excludedQuarantineRows: 0 };
  const verdict = run.overallResult === 'PASSED' || run.overallResult === 'WARNING' || run.overallResult === 'FAILED' ? run.overallResult : 'FAILED';
  return { badge: run.certifiedBlocked ? 'FAILED' : verdict, runId: run.id, excludedQuarantineRows: run.quarantinedCount };
}

export interface VersionContent {
  datasetCode: string;
  asOfPeriod: string;
  sourceSnapshotId: string;
  snapshotSha256: string;
  rowCount: number;
  qualityRunId: string | null;
  excludedQuarantineRows: number;
}

/** The checksum of a version: of what it is made of (the snapshot and its digest, the run and the rows it excluded), so two builds of the same content have the same checksum. */
export const versionChecksum = (content: VersionContent): string => sha256Hex(canonicalJson(content));

/** The rows that feed certified figures: what the snapshot has, less what the quality rules quarantined (never below zero). */
export const certifiedRows = (rowCount: number, excludedQuarantineRows: number): number => Math.max(0, rowCount - excludedQuarantineRows);

/** Whether a version of this quality may feed certified figures: not when the run blocked them, nor when the run measured other data. */
export const feedsCertified = (badge: QualityBadge): boolean => badge !== 'FAILED' && badge !== 'STALE';

/** Whether building again would change nothing: the same snapshot (and digest) with the same quality facts is the version that already stands. */
export function isSameBuild(existing: { checksumSha256: string }, next: VersionContent): boolean {
  return existing.checksumSha256 === versionChecksum(next);
}
