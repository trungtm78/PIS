import { createHash } from 'node:crypto';
import { Inject, Injectable, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { BOQ_LINE_FIELDS, MAX_BOQ_LINES } from '@machvon/db';
import { DEFAULT_TABULAR_LIMITS, DomainError, readTabularFile } from '@machvon/kernel';
import { FileService } from '../files';
import { MAX_IMPORT_FILE_BYTES, parseSingleFile } from '../sas/theme-assets';
import { tenantContextOf } from '../../tenant-context.decorator';

/** Request property that holds the key under which the BOQ file was stored, for the audit trail of the import. */
const FILE_KEY = 'boqFileKey';
/** The envelope of a multipart body (boundary lines and part headers) on top of the file. */
const ENVELOPE_ALLOWANCE = 16 * 1024;
/** The columns without which a file is not a BOQ. */
const REQUIRED_COLUMNS: readonly string[] = ['business_key', 'description', 'unit_code', 'quantity', 'unit_price'];
const MODES: readonly string[] = ['REPLACE', 'APPEND'];

interface BoqRequest extends AsyncIterable<Buffer | string> {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  tenantContext?: unknown;
  [FILE_KEY]?: string;
}

async function readBounded(stream: AsyncIterable<Buffer | string>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The faults of the header of a file, with the row 0 that stands for the header: a column that is not part of a BOQ, and one that is missing. */
function headerProblem(headers: readonly string[]): DomainError | undefined {
  const unknown = headers.filter((name) => name !== '' && !(BOQ_LINE_FIELDS as readonly string[]).includes(name)).map((field) => ({ row: 0, field, reason: 'notAllowed' }));
  const missing = REQUIRED_COLUMNS.filter((name) => !headers.includes(name)).map((field) => ({ row: 0, field, reason: 'required' }));
  const errors = [...unknown, ...missing];
  return errors.length === 0 ? undefined : new DomainError('VALIDATION_FAILED', 422, 'file', { extensions: { errors, error_rows: errors.length } });
}

/**
 * The guard of `importBoqLines` for a BOQ that arrives as a file (CTR 3.1 step 2, TK-CTR-002-6). A JSON body goes on to the command as it is.
 * A `multipart/form-data` body is judged before one row of it is read: its size (413), then what it is by its bytes, CSV or XLSX (422
 * FILE_TYPE_NOT_ALLOWED), then the scan of the shared storage (422 FILE_NOT_CLEAN, 409 SCAN_PENDING). Only a clean file is read as a table,
 * its columns checked against the fields of a BOQ line, and the lines it holds become the body of the command with the hash of the file, so
 * the command, its idempotency and its validation are those of the JSON form. The mode of the import is the query parameter `mode`.
 */
@Injectable()
export class BoqFileGuard implements CanActivate {
  constructor(@Inject(FileService) private readonly files: FileService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<BoqRequest>();
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('multipart/form-data')) return true;
    const length = Number(request.headers['content-length']);
    const limit = MAX_IMPORT_FILE_BYTES + ENVELOPE_ALLOWANCE;
    if (Number.isFinite(length) && length > limit) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
    const mode = request.query?.mode;
    if (typeof mode !== 'string' || !MODES.includes(mode)) throw new DomainError('VALIDATION_FAILED', 422, 'mode');
    const file = parseSingleFile(contentType, await readBounded(request, limit));
    if (file.bytes.length > MAX_IMPORT_FILE_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
    const tenant = tenantContextOf(request);
    // The storage judges the bytes (not the name) and scans them; nothing is read as a table before the verdict is CLEAN.
    const stored = await this.files.upload(tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const table = readTabularFile(file.bytes, { ...DEFAULT_TABULAR_LIMITS, maxRows: MAX_BOQ_LINES });
    const problem = headerProblem(table.headers);
    if (problem !== undefined) throw problem;
    const lines = table.rows.map((cells) => {
      const line: Record<string, string> = {};
      table.headers.forEach((name, index) => {
        const cell = cells[index] ?? '';
        if (name !== '' && cell.trim() !== '') line[name] = cell;
      });
      return line;
    });
    request[FILE_KEY] = stored.key;
    request.body = { mode, file_sha256: createHash('sha256').update(file.bytes).digest('hex'), lines };
    return true;
  }
}

/** The key under which the guard stored the BOQ file, or undefined when the lines came as JSON. */
export const BoqFileKey = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => context.switchToHttp().getRequest<BoqRequest>()[FILE_KEY]);
