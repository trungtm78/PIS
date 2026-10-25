import { createHash } from 'node:crypto';
import { Injectable, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext, Type } from '@nestjs/common';
import { DomainError, UPLOAD_PURPOSES } from '@machvon/kernel';

/** A logo is at most 1 MiB (`tenant_theme_asset` CHECK, AC-ST-SAS-005-4: a 1.5 MB image is refused). */
export const MAX_THEME_ASSET_BYTES = 1024 * 1024;
/** What the multipart envelope (boundary lines and part headers) may add to the file before the request is refused unread. */
const ENVELOPE_ALLOWANCE = 16 * 1024;
const MAX_BOUNDARY_LENGTH = 70;
const FILE_FIELD = 'file';
const UPLOAD_KEY = 'uploadedFile';
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

export interface UploadedFile {
  /** The type the client declared for the part, lower case and without parameters: the bytes are judged separately. */
  contentType: string;
  bytes: Buffer;
  /** SHA-256 of the bytes, hex. */
  sha256: string;
  /** The name the client gave the file, without any folder and cut to 200 characters; a module that shows the name back to the person keeps it, the others ignore it. */
  name?: string;
}

const invalid = (detail: string): DomainError => new DomainError('INVALID_REQUEST', 400, detail);

function boundaryOf(contentType: string | undefined): string {
  const match = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined || boundary.length > MAX_BOUNDARY_LENGTH) throw invalid('content-type');
  return boundary;
}

function parameterOf(header: string, name: string): string | undefined {
  const match = new RegExp(`[;\\s]${name}="([^"]*)"`, 'i').exec(header) ?? new RegExp(`[;\\s]${name}=([^\\s;]+)`, 'i').exec(header);
  return match?.[1];
}

/**
 * Reads the one file of a `multipart/form-data` body (RFC 7578). The request must hold exactly one part, named `file`
 * and carrying a file name; anything else, or a body that is not well formed, is 400 INVALID_REQUEST. The file name is
 * read to prove it is a file; it is handed on only as `name`, cleaned of folders and control characters.
 */
const MAX_NAME_LENGTH = 200;

/** The last segment of a file name, without control characters, at most 200 characters; empty when nothing is left. */
function cleanName(filename: string): string | undefined {
  const last = filename.split(/[\\/]/).pop() ?? '';
  const clean = Array.from(last)
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20 && character.codePointAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean === '' ? undefined : clean;
}

export function parseSingleFile(contentTypeHeader: string | undefined, body: Buffer): UploadedFile {
  const delimiter = Buffer.from(`--${boundaryOf(contentTypeHeader)}`);
  if (body.subarray(0, delimiter.length).compare(delimiter) !== 0) throw invalid('body');
  const afterOpening = delimiter.length;
  if (body.subarray(afterOpening, afterOpening + CRLF.length).compare(CRLF) !== 0) throw invalid('body');
  const headersStart = afterOpening + CRLF.length;
  const headersEnd = body.indexOf(HEADER_END, headersStart - CRLF.length);
  if (headersEnd < 0) throw invalid('body');
  const headers = body.subarray(headersStart, headersEnd).toString('latin1');
  const contentStart = headersEnd + HEADER_END.length;
  const closing = Buffer.concat([CRLF, delimiter]);
  const contentEnd = body.indexOf(closing, contentStart);
  if (contentEnd < 0) throw invalid('body');
  const tail = body.subarray(contentEnd + closing.length).toString('latin1');
  // After the only part comes the closing delimiter and at most a trailing line break: a second part is not allowed.
  if (!/^--(\r\n)?$/.test(tail)) throw invalid(tail.startsWith('--') ? 'body' : 'parts');

  const lines = headers.split('\r\n');
  const disposition = lines.find((line) => /^content-disposition\s*:/i.test(line));
  if (disposition === undefined || !/^content-disposition\s*:\s*form-data\s*(;|$)/i.test(disposition)) throw invalid('content-disposition');
  if (parameterOf(disposition, 'name') !== FILE_FIELD) throw invalid('name');
  const filename = parameterOf(disposition, 'filename');
  if (filename === undefined) throw invalid(FILE_FIELD);
  const declared = lines.find((line) => /^content-type\s*:/i.test(line));
  const contentType = (declared?.slice(declared.indexOf(':') + 1).split(';')[0] ?? 'application/octet-stream').trim().toLowerCase();
  const bytes = body.subarray(contentStart, contentEnd);
  return { contentType, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), name: cleanName(filename) };
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

interface UploadRequest extends AsyncIterable<Buffer | string> {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  [UPLOAD_KEY]?: UploadedFile;
}

/**
 * Reads a single-file upload before the command pipeline sees it (it runs after the authentication and policy guards, so a
 * caller who may not upload is refused before one byte is read). A request above the limit is 413 without being read to
 * the end. The body the pipeline hashes for idempotency is the description of the file (its type, size and SHA-256), so the
 * same key with another file is IDEMPOTENCY_CONFLICT, and the bytes travel on the request for the handler.
 */
function guardFor(maxBytes: number): Type<CanActivate> {
  @Injectable()
  class UploadGuard implements CanActivate {
    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<UploadRequest>();
      const length = Number(request.headers['content-length']);
      const limit = maxBytes + ENVELOPE_ALLOWANCE;
      if (Number.isFinite(length) && length > limit) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
      const contentType = request.headers['content-type'];
      const file = parseSingleFile(typeof contentType === 'string' ? contentType : undefined, await readBounded(request, limit));
      // The envelope allowance is for the boundary lines; the file itself is judged against the limit of the purpose.
      if (file.bytes.length > maxBytes) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
      request[UPLOAD_KEY] = file;
      request.body = { file: { content_type: file.contentType, size: file.bytes.length, sha256: file.sha256 } };
      return true;
    }
  }
  return UploadGuard;
}

/** The guard of the logo of a theme: one file of at most 1 MiB. */
export const SingleFileUploadGuard = guardFor(MAX_THEME_ASSET_BYTES);

/** The guard of a file of a bulk import: one file of at most 10 MiB, read by the import framework afterwards. */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const ImportFileUploadGuard = guardFor(MAX_IMPORT_FILE_BYTES);

/** The guard of a file of a bid: one file of at most the limit of a document (25 MiB), kept as it was handed in. */
export const MAX_DOCUMENT_FILE_BYTES = UPLOAD_PURPOSES.document.maxBytes;
export const DocumentFileUploadGuard = guardFor(MAX_DOCUMENT_FILE_BYTES);

/** The file that `SingleFileUploadGuard` read from the request. */
export const UploadedBytes = createParamDecorator((_data: unknown, context: ExecutionContext): UploadedFile => {
  const file = context.switchToHttp().getRequest<UploadRequest>()[UPLOAD_KEY];
  if (file === undefined) throw new Error('the upload guard did not run');
  return file;
});
