import { Readable } from 'node:stream';
import type { ExecutionContext } from '@nestjs/common';
import { DomainError } from '@machvon/kernel';
import { MAX_THEME_ASSET_BYTES, SingleFileUploadGuard, parseSingleFile } from '../src/modules/sas/theme-assets';

const BOUNDARY = 'xBOUNDARYx';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const FILE_HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`;
const bodyOf = (content: Buffer | string, head = FILE_HEAD, tail = `\r\n--${BOUNDARY}--\r\n`): Buffer => Buffer.concat([Buffer.from(head), Buffer.from(content), Buffer.from(tail)]);

function failureOf(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('parseSingleFile', () => {
  it('reads the bytes, the declared type and the SHA-256 of the one file', () => {
    const file = parseSingleFile(CONTENT_TYPE, bodyOf('abc'));
    expect(file.bytes.toString()).toBe('abc');
    expect(file.contentType).toBe('image/png');
    expect(file.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hands on the name of the file without its folders and control characters, and none when nothing is left', () => {
    expect(parseSingleFile(CONTENT_TYPE, bodyOf('x')).name).toBe('logo.png');
    const named = (name: string) => bodyOf('x', FILE_HEAD.replace('logo.png', name));
    expect(parseSingleFile(CONTENT_TYPE, named('C:\\Users\\an\\statement.csv')).name).toBe('statement.csv');
    expect(parseSingleFile(CONTENT_TYPE, named('../../etc/sao ke.csv')).name).toBe('sao ke.csv');
    expect(parseSingleFile(CONTENT_TYPE, named('a'.repeat(300) + '.csv')).name).toHaveLength(200);
    expect(parseSingleFile(CONTENT_TYPE, named('')).name).toBeUndefined();
    expect(parseSingleFile(CONTENT_TYPE, named('dir/')).name).toBeUndefined();
  });

  it('keeps bytes that look like a line break or a partial delimiter, and accepts a quoted boundary and no closing line break', () => {
    const tricky = Buffer.concat([Buffer.from('\r\n--'), Buffer.from(BOUNDARY.slice(0, 3)), Buffer.from([0x00, 0xff, 0x0d])]);
    expect(parseSingleFile(`multipart/form-data; boundary="${BOUNDARY}"`, bodyOf(tricky, FILE_HEAD, `\r\n--${BOUNDARY}--`)).bytes.equals(tricky)).toBe(true);
  });

  it('lower-cases the declared type, drops its parameters and falls back to a binary type when none is declared', () => {
    const typed = bodyOf('x', FILE_HEAD.replace('image/png', 'Image/PNG; charset=binary'));
    expect(parseSingleFile(CONTENT_TYPE, typed).contentType).toBe('image/png');
    const untyped = bodyOf('x', FILE_HEAD.replace('Content-Type: image/png\r\n', ''));
    expect(parseSingleFile(CONTENT_TYPE, untyped).contentType).toBe('application/octet-stream');
  });

  it('refuses a header without a usable boundary', () => {
    for (const header of [undefined, 'application/json', 'multipart/form-data', `multipart/form-data; boundary=${'b'.repeat(71)}`]) {
      expect(failureOf(() => parseSingleFile(header, bodyOf('x'))).code).toBe('INVALID_REQUEST');
    }
  });

  it('refuses a body that is not well formed', () => {
    const cases = [
      Buffer.from(''),
      Buffer.from(`--${BOUNDARY}`),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n`),
      Buffer.from(`${'x'}--${BOUNDARY}\r\n\r\n`),
      Buffer.from(FILE_HEAD + 'never closed'),
      bodyOf('x', FILE_HEAD, `\r\n--${BOUNDARY}--\r\nepilogue`),
    ];
    for (const body of cases) expect(failureOf(() => parseSingleFile(CONTENT_TYPE, body)).code).toBe('INVALID_REQUEST');
  });

  it('refuses a part that is not a file named file, and a second part', () => {
    const named = (disposition: string): Buffer => bodyOf('x', `--${BOUNDARY}\r\n${disposition}\r\n\r\n`);
    expect(failureOf(() => parseSingleFile(CONTENT_TYPE, named('Content-Disposition: form-data; name="other"; filename="a.png"'))).detail).toBe('name');
    expect(failureOf(() => parseSingleFile(CONTENT_TYPE, named('Content-Disposition: form-data; name="file"'))).detail).toBe('file');
    expect(failureOf(() => parseSingleFile(CONTENT_TYPE, named('Content-Disposition: attachment; name="file"; filename="a"'))).detail).toBe('content-disposition');
    expect(failureOf(() => parseSingleFile(CONTENT_TYPE, named('X-Other: 1'))).detail).toBe('content-disposition');
    const two = Buffer.concat([bodyOf('one', FILE_HEAD, `\r\n`), Buffer.from(`${FILE_HEAD}two\r\n--${BOUNDARY}--\r\n`)]);
    expect(failureOf(() => parseSingleFile(CONTENT_TYPE, two)).detail).toBe('parts');
  });

  it('reads an unquoted file name and an empty header block position without keeping the name', () => {
    const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name=file; filename=logo.png\r\n\r\n`;
    expect(parseSingleFile(CONTENT_TYPE, bodyOf('x', head)).bytes.toString()).toBe('x');
    expect(failureOf(() => parseSingleFile(CONTENT_TYPE, bodyOf('x', `--${BOUNDARY}\r\n\r\n`))).code).toBe('INVALID_REQUEST');
  });
});

describe('SingleFileUploadGuard', () => {
  const guard = new SingleFileUploadGuard();

  function requestOf(body: Buffer, headers: Record<string, string>): Record<string, unknown> {
    const stream = Readable.from([body.subarray(0, 7), body.subarray(7)]) as unknown as Record<string, unknown>;
    stream.headers = headers;
    return stream;
  }

  const contextOf = (request: Record<string, unknown>): ExecutionContext => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

  it('replaces the body by the description of the file and hands the bytes over on the request', async () => {
    const request = requestOf(bodyOf('abc'), { 'content-type': CONTENT_TYPE });
    await expect(guard.canActivate(contextOf(request))).resolves.toBe(true);
    expect(request.body).toEqual({ file: { content_type: 'image/png', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' } });
    expect((request.uploadedFile as { bytes: Buffer }).bytes.toString()).toBe('abc');
  });

  it('refuses by Content-Length without reading, and refuses a stream that grows past the limit without one', async () => {
    const declared = requestOf(bodyOf('abc'), { 'content-type': CONTENT_TYPE, 'content-length': String(MAX_THEME_ASSET_BYTES * 2) });
    await expect(guard.canActivate(contextOf(declared))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
    const undeclared = requestOf(bodyOf(Buffer.alloc(MAX_THEME_ASSET_BYTES + 32 * 1024, 0x61)), { 'content-type': CONTENT_TYPE });
    await expect(guard.canActivate(contextOf(undeclared))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
  });

  it('refuses a request that is not multipart', async () => {
    const request = requestOf(Buffer.from('{}'), { 'content-type': 'application/json' });
    await expect(guard.canActivate(contextOf(request))).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    const untyped = requestOf(Buffer.from('{}'), {});
    await expect(guard.canActivate(contextOf(untyped))).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });
});
