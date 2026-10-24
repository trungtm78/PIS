/** The permissions DOC-09 needs (x-permission in openapi.json). */
export const UPLOAD_FILE_PERMISSION = 'doc.file.upload';
export const UPLOAD_SIGNED_PERMISSION = 'doc.outgoing.upload_signed';
export const REGISTER_EXTERNAL_PERMISSION = 'doc.outgoing.register_external';

/** The limit of the upload guard (10 MiB): a larger file is refused before it is sent. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const MODES = ['LEADER', 'EXTERNAL'] as const;
export type Mode = (typeof MODES)[number];

export const OVERALL = ['VALID', 'INVALID', 'INDETERMINATE'] as const;
export type Overall = (typeof OVERALL)[number];
export const ROLES = ['LEADER', 'ORGANIZATION', 'EXTERNAL', 'DOCUMENT_TIMESTAMP'] as const;
export type SignatureRole = (typeof ROLES)[number];
export const CHAINS = ['TRUSTED', 'UNTRUSTED', 'INCOMPLETE', 'NOT_CHECKED'] as const;
export type ChainStatus = (typeof CHAINS)[number];

/** What the server read in one signature of the uploaded file. */
export interface SignatureVerdict {
  role: SignatureRole;
  status: Overall;
  chainStatus: ChainStatus;
  signedAt: string | null;
  timestampProven: boolean;
  findings: string[];
}

/** The answer of `uploadDocumentFile`: where the file is kept and what it holds. */
export interface FileCheck {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  pageCount: number;
  overall: Overall;
  signatures: SignatureVerdict[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T => values.find((candidate) => candidate === value) ?? fallback;

function toVerdict(raw: unknown): SignatureVerdict[] {
  if (!isRecord(raw)) return [];
  return [
    {
      role: oneOf(ROLES, raw.role, 'EXTERNAL'),
      status: oneOf(OVERALL, raw.status, 'INDETERMINATE'),
      chainStatus: oneOf(CHAINS, raw.chain_status, 'NOT_CHECKED'),
      signedAt: typeof raw.signed_at === 'string' ? raw.signed_at : null,
      timestampProven: raw.timestamp_proven === true,
      findings: Array.isArray(raw.findings) ? raw.findings.filter((finding): finding is string => typeof finding === 'string') : [],
    },
  ];
}

export function toFileCheck(raw: unknown): FileCheck | undefined {
  if (!isRecord(raw) || text(raw.file_object_key) === '' || text(raw.file_sha256) === '') return undefined;
  return {
    fileObjectKey: text(raw.file_object_key),
    fileSha256: text(raw.file_sha256),
    sizeBytes: count(raw.size_bytes),
    pageCount: count(raw.page_count),
    overall: oneOf(OVERALL, raw.overall, 'INDETERMINATE'),
    signatures: Array.isArray(raw.signatures) ? raw.signatures.flatMap(toVerdict) : [],
  };
}

/** What a command that took the file answers, for the notice and the link. */
export interface AttachResult {
  id: string;
  status: string;
  symbol: string | null;
  number: number | null;
}

export function toAttachResult(raw: unknown): AttachResult {
  const body: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(body.resource_id),
    status: text(body.status),
    symbol: typeof body.symbol === 'string' ? body.symbol : null,
    number: typeof body.number === 'number' ? body.number : null,
  };
}
