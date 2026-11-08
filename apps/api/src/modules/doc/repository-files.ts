import { unzipSync } from 'fflate';
import { DomainError, FORMAT_MIME, fileSha256, normaliseExtraction, parseObjectKey, repositoryFormatOf, validateUpload } from '@machvon/kernel';
import type { RepositoryFormat, TenantContext } from '@machvon/kernel';
import type { ExtractionRecord, FileFacts } from '@machvon/db';
import type { FileService } from '../files';
import type { DocumentTextExtractionPort } from './text-extraction';

/**
 * The files of the project repository on their way in and out of the object store (DOC-2). A file comes in through the upload pipeline (judged by its bytes, scanned, stored under the tenant); a command then names it
 * by key and hash, and this opens it again: the key must be a clean document of this tenant, the hash must still be the one named, its format must be one the repository keeps and its content must be that format.
 * The text is read in the process of the API, behind the port, and never leaves it.
 */

const MAX_ENTRIES = 5000;
const MAX_DECLARED_BYTES = 200 * 1024 * 1024;
const PDF_HEADER = '%PDF-';

const PART_OF: Readonly<Record<'DOCX' | 'XLSX', string>> = { DOCX: 'word/document.xml', XLSX: 'xl/workbook.xml' };

/** The names of the entries of a zip, from its directory only (nothing is inflated); a zip that declares too much or too many entries is not a document. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  let declared = 0;
  try {
    unzipSync(bytes, {
      filter: (file) => {
        declared += file.originalSize;
        names.push(file.name);
        if (declared > MAX_DECLARED_BYTES || names.length > MAX_ENTRIES) throw new Error('zip too large');
        return false;
      },
    });
  } catch {
    throw new DomainError('DOC_FILE_FORMAT_MISMATCH', 422, 'file');
  }
  return names;
}

/** 422 `DOC_FILE_FORMAT_MISMATCH` unless the bytes are what the format says: a PDF by its header, a Word file or a workbook by the part that makes it one. */
export function assertContentMatchesFormat(bytes: Uint8Array, format: RepositoryFormat): void {
  if (format === 'PDF') {
    if (Buffer.from(bytes.subarray(0, PDF_HEADER.length)).toString('latin1') !== PDF_HEADER) throw new DomainError('DOC_FILE_FORMAT_MISMATCH', 422, 'file');
    return;
  }
  if (!zipEntryNames(bytes).includes(PART_OF[format])) throw new DomainError('DOC_FILE_FORMAT_MISMATCH', 422, 'file');
}

export interface OpenedFile {
  bytes: Uint8Array;
  facts: FileFacts;
}

export class RepositoryFiles {
  constructor(
    private readonly files: FileService,
    private readonly reader: DocumentTextExtractionPort,
  ) {}

  /** Judges an upload and stores it: only the three formats, the content of the format, clean. Returns the facts a screen shows. */
  async stage(tenant: TenantContext, upload: { declaredType: string; bytes: Uint8Array }): Promise<{ key: string; sha256: string; format: RepositoryFormat; mime: string }> {
    const verdict = validateUpload({ declaredType: upload.declaredType, bytes: upload.bytes, purpose: 'document' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const format = repositoryFormatOf(verdict.contentType);
    if (format === undefined) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422);
    assertContentMatchesFormat(upload.bytes, format);
    const stored = await this.files.upload(tenant, { purpose: 'document', declaredType: upload.declaredType, bytes: upload.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    return { key: stored.key, sha256: fileSha256(upload.bytes), format, mime: FORMAT_MIME[format] };
  }

  /** Opens a staged file by key and hash: a clean document of this tenant, unchanged since it was staged, in a format the repository keeps. */
  async open(tenant: TenantContext, key: string, sha256: string): Promise<OpenedFile> {
    const parts = parseObjectKey(key);
    if (parts === undefined || parts.kind !== 'document') throw new DomainError('VALIDATION_FAILED', 422, 'file_object_key', { extensions: { reason: 'FILE_KEY_INVALID' } });
    const { object, bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file_sha256');
    const format = repositoryFormatOf(object.contentType);
    if (format === undefined) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422, 'file_object_key');
    assertContentMatchesFormat(bytes, format);
    return { bytes, facts: { key, sha256, sizeBytes: bytes.length, format, mime: FORMAT_MIME[format], pageCount: null } };
  }

  /** Reads the text of an opened file into the units a version keeps; the page count of a PDF comes from the reader. */
  async read(file: OpenedFile): Promise<{ record: ExtractionRecord; facts: FileFacts }> {
    const reading = await this.reader.extract({ bytes: file.bytes, format: file.facts.format, sha256: file.facts.sha256 });
    const failed = reading.status === 'FAILED';
    const normalised = failed ? { units: [], truncated: 0 } : normaliseExtraction(file.facts.sha256, reading.units);
    return {
      record: { units: normalised.units, truncated: normalised.truncated + reading.omitted, failed, engine: reading.engine },
      facts: { ...file.facts, pageCount: reading.pageCount },
    };
  }
}
