import { connect } from 'node:net';
import type { ScanPort, ScanVerdict } from '@machvon/kernel';
import { MockScanPort } from './mock-scan';

/**
 * The scanner could not give a verdict: it is not configured, not reachable, too slow, or it answered with an error. This is NOT a verdict. The upload pipeline keeps the file PENDING (nothing
 * can link or download it) and the portal hook answers UNAVAILABLE: a file is never CLEAN because the scanner was away (closed by default, HSKT YCK.07).
 */
export class ScanUnavailableError extends Error {
  constructor(readonly reason: 'NOT_CONFIGURED' | 'CONNECTION' | 'TIMEOUT' | 'TOO_LARGE' | 'SCANNER_ERROR' | 'BAD_REPLY', detail = '') {
    super(`scan unavailable: ${reason}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'ScanUnavailableError';
  }
}

/** Stands in where no scanner is configured: every scan is unavailable, never clean. */
export class UnconfiguredScanPort implements ScanPort {
  scan(): Promise<ScanVerdict> {
    return Promise.reject(new ScanUnavailableError('NOT_CONFIGURED'));
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  /** The whole exchange (connect, stream, answer) must end within this time. */
  timeoutMs?: number;
  /** Larger files are refused as TOO_LARGE; keep it at or below clamd's StreamMaxLength. */
  maxBytes?: number;
  /** Size of the chunks of the INSTREAM command. */
  chunkBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * The answer of clamd to INSTREAM: `stream: OK`, `stream: <signature> FOUND` or `... ERROR`. Anything else, including an empty answer, is not a verdict.
 * With the `z` prefix of the command the reply ends with a NUL byte.
 */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0+$/, '').trim();
  if (/^stream: OK$/.test(text)) return 'CLEAN';
  if (/^stream: .+ FOUND$/.test(text)) return 'INFECTED';
  if (/ERROR$/.test(text)) throw new ScanUnavailableError('SCANNER_ERROR', text.slice(0, 120));
  throw new ScanUnavailableError('BAD_REPLY', text.slice(0, 120));
}

/**
 * ScanPort adapter of ClamAV: speaks the clamd `zINSTREAM` command over TCP (a length-prefixed stream of chunks, closed by a zero-length chunk) and reads the one-line reply. Host and port
 * come from the configuration (`scanPortFromEnvironment`). A refused connection, a timeout, a file above the limit and an error reply all throw ScanUnavailableError. Only `stream: OK` is CLEAN.
 */
export class ClamdScanPort implements ScanPort {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly chunkBytes: number;

  constructor(private readonly options: ClamdOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  }

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    if (bytes.length > this.maxBytes) return Promise.reject(new ScanUnavailableError('TOO_LARGE', `${bytes.length} bytes`));
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      const received: Buffer[] = [];
      let settled = false;
      const finish = (outcome: () => ScanVerdict): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(outcome());
        } catch (error) {
          reject(error);
        }
      };
      const fail = (error: ScanUnavailableError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new ScanUnavailableError('TIMEOUT', `${this.timeoutMs} ms`)), this.timeoutMs);
      socket.on('error', (error) => fail(new ScanUnavailableError('CONNECTION', error.message)));
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        // The reply of the z-prefixed command ends with NUL: no need to wait for the close.
        if (chunk.includes(0)) finish(() => parseClamdReply(Buffer.concat(received).toString('utf8')));
      });
      socket.on('end', () => finish(() => parseClamdReply(Buffer.concat(received).toString('utf8'))));
      socket.on('close', () => finish(() => parseClamdReply(Buffer.concat(received).toString('utf8'))));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += this.chunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(offset + this.chunkBytes, bytes.length));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length, 0);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/**
 * The scan adapter chosen by the environment, closed by default:
 *  - `MACHVON_SCAN_ADAPTER=clamav` with `MACHVON_CLAMD_HOST` (and `MACHVON_CLAMD_PORT`, default 3310): ClamAV. Without a host: unconfigured, every scan unavailable.
 *  - `MACHVON_SCAN_ADAPTER=mock`: the EICAR-only MOCK, for development and tests, refused (unconfigured) when `NODE_ENV` is `production`.
 *  - nothing set: the MOCK outside production (development and tests keep working), unconfigured in production.
 * Unknown values are unconfigured, never the MOCK.
 */
export function scanPortFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): ScanPort {
  const production = env.NODE_ENV === 'production';
  const adapter = (env.MACHVON_SCAN_ADAPTER ?? '').toLowerCase();
  if (adapter === 'clamav') return clamdFromEnvironment(env) ?? new UnconfiguredScanPort();
  if (adapter === 'mock' || adapter === '') return production ? new UnconfiguredScanPort() : new MockScanPort();
  return new UnconfiguredScanPort();
}

/** The ClamAV adapter of the environment, or undefined when no host is configured or the port or time limit is not a number. */
export function clamdFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): ClamdScanPort | undefined {
  const host = env.MACHVON_CLAMD_HOST?.trim();
  if (host === undefined || host === '') return undefined;
  const port = env.MACHVON_CLAMD_PORT === undefined || env.MACHVON_CLAMD_PORT === '' ? 3310 : Number(env.MACHVON_CLAMD_PORT);
  const timeoutMs = env.MACHVON_CLAMD_TIMEOUT_MS === undefined || env.MACHVON_CLAMD_TIMEOUT_MS === '' ? undefined : Number(env.MACHVON_CLAMD_TIMEOUT_MS);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) return undefined;
  return new ClamdScanPort({ host, port, timeoutMs });
}
