import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { canonicalJson } from '@machvon/kernel';
import type { IssuedCopyMarks } from '@machvon/kernel';
import { HPM_ADAPTER_STATUS, HPM_PACKAGE_FORMAT, hpmAcceptance } from './hpm-rules.ts';
import type { HpmAcceptance } from './hpm-rules.ts';

/**
 * The port to HPM, the reporting platform of the customer (ENT-2, R18). Its technical interface is not known, so the only adapter is a file writer: it builds a delivery package and hands it to a sink (a folder, an object
 * store); it never opens a connection to anything. An API adapter replaces it when the customer publishes the interface, with nothing else changing: the ledger, the rules and the screens read the port, not the adapter.
 */

/** One project of the report and the code HPM knows it by (ENT-3e): `via` says whether the code came from the crosswalk or is our own code sent under the fallback of this version. */
export interface HpmProjectCode {
  projectId: string;
  ourCode: string;
  hpmCode: string;
  via: 'CROSSWALK' | 'DIRECT' | 'UNMAPPED';
}

/** What the adapter is given: the report as issued, with its key (the same key on every retry) and the numbers that identify it. */
export interface HpmDeliveryRequest {
  key: string;
  requestHash: string;
  tenantId: string;
  /** The number of this try of the key: 1 for the first, more for a re-send. */
  attempt: number;
  copy: {
    orgId: string;
    layoutCode: string;
    period: string;
    revision: number;
    sha256: string;
    snapshot: { snapshotId: string; revision: number; cutoff: string } | null;
    marks: IssuedCopyMarks | null;
    /** The projects of the snapshot with their HPM codes; absent for a copy that has no snapshot (the manifest then has no list, as before). */
    projectCodes?: readonly HpmProjectCode[];
  };
  fileName: string;
  bytes: Uint8Array;
  /** More files of the same issued copy (the Word version next to the workbook): they travel in the package under their own names. */
  attachments?: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
  sentAt: Date;
}

/** What the adapter answers. For the file writer it is where the package was written and its hash; the receiver has not said anything yet. */
export interface HpmDeliveryResponse {
  mode: 'FILE';
  location: string;
  packageName: string;
  packageSha256: string;
  packageSize: number;
  packageFormat: string;
  receiver: 'AWAITING_RECEIPT';
  acceptance: HpmAcceptance;
}

export interface HpmPort {
  readonly adapterStatus: typeof HPM_ADAPTER_STATUS;
  readonly packageFormat: string;
  deliver(request: HpmDeliveryRequest): Promise<HpmDeliveryResponse>;
}

/** Where a package goes: a name inside the tenant's own space and the bytes; the answer is the location to show (never an absolute path of the server). */
export type HpmFileSink = (tenantId: string, name: string, bytes: Uint8Array) => Promise<string>;

const SAFE = /[^A-Za-z0-9._-]+/g;

/**
 * The name of the package: layout, period and revision, so a person can tell a correction from the first copy at a glance, and a short tag of the organisation (the key of the push tells
 * organisations apart, so the name must too: two organisations of one tenant never write over each other's package).
 */
export function hpmPackageName(copy: Pick<HpmDeliveryRequest['copy'], 'orgId' | 'layoutCode' | 'period' | 'revision'>): string {
  const org = createHash('sha256').update(copy.orgId.toLowerCase()).digest('hex').slice(0, 10);
  return `HPM-${copy.layoutCode}-${copy.period}-r${copy.revision}-${org}.zip`.replace(SAFE, '_');
}

/** The manifest inside the package: what the receiver needs to recognise the copy, and the words that tell it this is a working assumption. */
export function hpmManifestOf(request: HpmDeliveryRequest): Record<string, unknown> {
  return {
    package_format: HPM_PACKAGE_FORMAT,
    acceptance: hpmAcceptance(HPM_PACKAGE_FORMAT),
    key: request.key,
    request_hash: request.requestHash,
    attempt: request.attempt,
    org_unit_id: request.copy.orgId,
    layout_code: request.copy.layoutCode,
    period: request.copy.period,
    revision: request.copy.revision,
    report_file: request.fileName,
    report_sha256: request.copy.sha256,
    attachments: (request.attachments ?? []).map((file) => ({ file: file.name, sha256: createHash('sha256').update(file.bytes).digest('hex') })),
    snapshot: request.copy.snapshot === null ? null : { snapshot_id: request.copy.snapshot.snapshotId, revision: request.copy.snapshot.revision, cutoff: request.copy.snapshot.cutoff },
    ...(request.copy.projectCodes === undefined
      ? {}
      : {
          project_codes: request.copy.projectCodes.map((one) => ({ project_id: one.projectId, our_code: one.ourCode, hpm_code: one.hpmCode, via: one.via })),
          project_codes_unmapped: request.copy.projectCodes.filter((one) => one.via !== 'CROSSWALK').length,
        }),
    form_status: request.copy.marks?.formStatus ?? null,
    demo_mark: request.copy.marks?.demoMark ?? null,
    sent_at: request.sentAt.toISOString(),
  };
}

const FIXED_TIME = Date.UTC(2026, 0, 1);

/** The package as bytes: the manifest and the report, stored (not compressed) with a fixed time, so the same request always yields the same bytes; a re-send differs from the first package only by the attempt number and the time in its manifest, and carries the same key. */
export function buildHpmPackage(request: HpmDeliveryRequest): Uint8Array {
  const mtime = new Date(FIXED_TIME);
  return zipSync(
    {
      'manifest.json': [strToU8(canonicalJson(hpmManifestOf(request))), { level: 0, mtime }],
      [`report/${request.fileName.replace(SAFE, '_')}`]: [request.bytes, { level: 0, mtime }],
      ...Object.fromEntries((request.attachments ?? []).map((file): [string, [Uint8Array, { level: 0; mtime: Date }]] => [`report/${file.name.replace(SAFE, '_')}`, [file.bytes, { level: 0, mtime }]])),
    },
    { level: 0, mtime },
  );
}

/**
 * The file writer: builds the package and hands it to the sink. Nothing here imports a network module and nothing is sent; the test suite holds it to that by watching the sockets. The verdict on the connector stays PROPOSED
 * and every answer says the receiver has not confirmed (PENDING-EXTERNAL) until a person records the receipt.
 */
export class HpmFileWriter implements HpmPort {
  readonly adapterStatus = HPM_ADAPTER_STATUS;
  readonly packageFormat = HPM_PACKAGE_FORMAT;

  private readonly sink: HpmFileSink;

  constructor(sink: HpmFileSink) {
    this.sink = sink;
  }

  async deliver(request: HpmDeliveryRequest): Promise<HpmDeliveryResponse> {
    const bytes = buildHpmPackage(request);
    const packageName = hpmPackageName(request.copy);
    const location = await this.sink(request.tenantId, packageName, bytes);
    return {
      mode: 'FILE',
      location,
      packageName,
      packageSha256: createHash('sha256').update(bytes).digest('hex'),
      packageSize: bytes.length,
      packageFormat: HPM_PACKAGE_FORMAT,
      receiver: 'AWAITING_RECEIPT',
      acceptance: hpmAcceptance(HPM_PACKAGE_FORMAT),
    };
  }
}
