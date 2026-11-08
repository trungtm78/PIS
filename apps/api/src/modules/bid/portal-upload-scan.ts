import type { PortalScanVerdict } from '@machvon/kernel';

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

/** The adapter chosen by the environment: fail closed unless `MACHVON_PORTAL_SCAN` is `PIPELINE`. */
export function portalScanFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): PortalUploadScanPort {
  return env.MACHVON_PORTAL_SCAN === 'PIPELINE' ? new PipelinePortalScan() : new FailClosedPortalScan();
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
