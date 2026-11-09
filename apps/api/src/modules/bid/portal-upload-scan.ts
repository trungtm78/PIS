import type { PortalScanVerdict, ScanPort } from '@machvon/kernel';
import { clamdFromEnvironment } from '../files/clamd-scan';

/**
 * The scan hook of the files a contractor puts on the portal (PORTAL-2; docs/vendor-investigation.md section 14). The portal is the one door a stranger uses, so a file is judged BEFORE it is stored: the hook answers CLEAN,
 * INFECTED or UNAVAILABLE (no scanner, a failure, a timeout), and only CLEAN goes on. The default adapter is `FailClosedPortalScan`: until an operator wires a scanner (a ClamAV adapter behind this port, inside Vietnam) every
 * portal upload is refused with 409 `SCAN_PENDING`. An operator who accepts that the shared upload pipeline scanner (which also scans every file after it is stored) is enough opts in with `MACHVON_PORTAL_SCAN=PIPELINE`.
 */
export interface PortalUploadScanPort {
  scan(bytes: Uint8Array, context: { tenantId: string; mime: string }): Promise<PortalScanVerdict>;
}

/** No scanner is wired: nothing is clean. */
export class FailClosedPortalScan implements PortalUploadScanPort {
  scan(): Promise<PortalScanVerdict> {
    return Promise.resolve('UNAVAILABLE');
  }
}

/** The operator chose to rely on the scan of the shared pipeline, which still scans the stored file and refuses an infected one; this hook adds no verdict of its own. */
export class PipelinePortalScan implements PortalUploadScanPort {
  scan(): Promise<PortalScanVerdict> {
    return Promise.resolve('CLEAN');
  }
}

/** The portal hook on top of any scan port (the ClamAV adapter): CLEAN and INFECTED are the scanner's verdicts, every failure of the scanner is UNAVAILABLE, never CLEAN. */
export class ScanPortPortalScan implements PortalUploadScanPort {
  constructor(private readonly port: ScanPort) {}

  async scan(bytes: Uint8Array): Promise<PortalScanVerdict> {
    try {
      return await this.port.scan(bytes);
    } catch {
      return 'UNAVAILABLE';
    }
  }
}

/**
 * The adapter chosen by the environment: `MACHVON_PORTAL_SCAN=CLAMAV` scans every portal upload with clamd (`MACHVON_CLAMD_HOST`, `MACHVON_CLAMD_PORT`) before it is stored, and refuses (UNAVAILABLE) when clamd
 * is not configured or does not answer; `PIPELINE` relies on the shared pipeline scan; anything else fails closed.
 */
export function portalScanFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): PortalUploadScanPort {
  if (env.MACHVON_PORTAL_SCAN === 'PIPELINE') return new PipelinePortalScan();
  if (env.MACHVON_PORTAL_SCAN === 'CLAMAV') {
    const clamd = clamdFromEnvironment(env);
    return clamd === undefined ? new FailClosedPortalScan() : new ScanPortPortalScan(clamd);
  }
  return new FailClosedPortalScan();
}

/** A hook that throws or answers with something unknown is UNAVAILABLE: the answer is never read as clean by accident. */
export async function scanFailClosed(port: PortalUploadScanPort, bytes: Uint8Array, context: { tenantId: string; mime: string }): Promise<PortalScanVerdict> {
  try {
    const verdict = await port.scan(bytes, context);
    return verdict === 'CLEAN' || verdict === 'INFECTED' ? verdict : 'UNAVAILABLE';
  } catch {
    return 'UNAVAILABLE';
  }
}
