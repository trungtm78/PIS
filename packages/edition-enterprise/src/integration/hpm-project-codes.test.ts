import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { buildHpmPackage, hpmManifestOf } from './hpm-port.ts';
import type { HpmDeliveryRequest, HpmProjectCode } from './hpm-port.ts';

const REPORT = new TextEncoder().encode('report bytes of the month');
const REPORT_SHA = createHash('sha256').update(REPORT).digest('hex');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const request = (projectCodes?: readonly HpmProjectCode[]): HpmDeliveryRequest => ({
  key: `${A}|HPM-MONTHLY|2026-M10|r2`,
  requestHash: 'a'.repeat(64),
  tenantId: B,
  attempt: 1,
  copy: {
    orgId: A,
    layoutCode: 'HPM-MONTHLY',
    period: '2026-M10',
    revision: 2,
    sha256: REPORT_SHA,
    snapshot: { snapshotId: '33333333-3333-4333-8333-333333333333', revision: 4, cutoff: '2026-10-31' },
    marks: null,
    ...(projectCodes === undefined ? {} : { projectCodes }),
  },
  fileName: 'HPM monthly 2026-10.xlsx',
  bytes: REPORT,
  sentAt: new Date('2026-11-08T03:00:00Z'),
});

describe('the project codes in the HPM package (ENT-3e, TH.03)', () => {
  it('a copy that names no projects has the manifest it always had (no list, no count)', () => {
    const manifest = hpmManifestOf(request());
    expect(manifest).not.toHaveProperty('project_codes');
    expect(manifest).not.toHaveProperty('project_codes_unmapped');
  });

  it('lists each project with the code HPM knows it by, how it was found, and counts those that still go under our own code', () => {
    const manifest = hpmManifestOf(
      request([
        { projectId: A, ourCode: 'PRJ-001', hpmCode: 'HPM-77', via: 'CROSSWALK' },
        { projectId: B, ourCode: 'PRJ-002', hpmCode: 'PRJ-002', via: 'DIRECT' },
      ]),
    );
    expect(manifest.project_codes).toEqual([
      { project_id: A, our_code: 'PRJ-001', hpm_code: 'HPM-77', via: 'CROSSWALK' },
      { project_id: B, our_code: 'PRJ-002', hpm_code: 'PRJ-002', via: 'DIRECT' },
    ]);
    expect(manifest.project_codes_unmapped).toBe(1);
  });

  it('the package carries the list in its manifest and stays byte for byte the same for the same request', () => {
    const codes: HpmProjectCode[] = [{ projectId: A, ourCode: 'PRJ-001', hpmCode: 'HPM-77', via: 'CROSSWALK' }];
    const first = buildHpmPackage(request(codes));
    expect(Buffer.from(first).equals(Buffer.from(buildHpmPackage(request(codes))))).toBe(true);
    const manifest = JSON.parse(strFromU8(unzipSync(first)['manifest.json'] as Uint8Array)) as Record<string, unknown>;
    expect(manifest.project_codes_unmapped).toBe(0);
    expect(manifest.project_codes).toHaveLength(1);
  });
});
