import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { HpmFileWriter, buildHpmPackage, hpmManifestOf, hpmPackageName } from './hpm-port.ts';
import type { HpmDeliveryRequest } from './hpm-port.ts';
import { HPM_ADAPTER_STATUS, HPM_PACKAGE_FORMAT } from './hpm-rules.ts';

const REPORT = new TextEncoder().encode('report bytes of the month');
const REPORT_SHA = createHash('sha256').update(REPORT).digest('hex');

const request = (patch: Partial<HpmDeliveryRequest> = {}): HpmDeliveryRequest => ({
  key: '11111111-1111-4111-8111-111111111111|HPM-MONTHLY|2026-M10|r2',
  requestHash: 'a'.repeat(64),
  tenantId: '22222222-2222-4222-8222-222222222222',
  attempt: 1,
  copy: { orgId: '11111111-1111-4111-8111-111111111111', layoutCode: 'HPM-MONTHLY', period: '2026-M10', revision: 2, sha256: REPORT_SHA, snapshot: { snapshotId: '33333333-3333-4333-8333-333333333333', revision: 4, cutoff: '2026-10-31' }, marks: null },
  fileName: 'HPM monthly 2026-10.xlsx',
  bytes: REPORT,
  sentAt: new Date('2026-11-08T03:00:00Z'),
  ...patch,
});

describe('the delivery package of the file writer', () => {
  it('names the package after the layout, the period and the revision, with nothing a file system dislikes', () => {
    const org = '11111111-1111-4111-8111-111111111111';
    const tag = createHash('sha256').update(org).digest('hex').slice(0, 10);
    expect(hpmPackageName({ orgId: org, layoutCode: 'HPM-MONTHLY', period: '2026-M10', revision: 2 })).toBe(`HPM-HPM-MONTHLY-2026-M10-r2-${tag}.zip`);
    expect(hpmPackageName({ orgId: org, layoutCode: 'A B/C', period: '2026', revision: 1 })).toBe(`HPM-A_B_C-2026-r1-${tag}.zip`);
  });

  it('gives two organisations of one tenant two packages for the same layout, period and revision, and the same organisation the same one every time', () => {
    const same = { layoutCode: 'HPM-MONTHLY', period: '2026-M10', revision: 1 };
    const first = hpmPackageName({ ...same, orgId: '11111111-1111-4111-8111-111111111111' });
    const second = hpmPackageName({ ...same, orgId: '11111111-1111-4111-8111-111111111112' });
    expect(first).not.toBe(second);
    expect(hpmPackageName({ ...same, orgId: '11111111-1111-4111-8111-111111111111' })).toBe(first);
    expect(hpmPackageName({ ...same, orgId: '11111111-1111-4111-8111-111111111111'.toUpperCase() })).toBe(first);
  });

  it('carries the manifest and the report byte for byte, and says it is a working assumption', () => {
    const files = unzipSync(buildHpmPackage(request()));
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'report/HPM_monthly_2026-10.xlsx']);
    expect(files['report/HPM_monthly_2026-10.xlsx']).toEqual(REPORT);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      package_format: HPM_PACKAGE_FORMAT,
      acceptance: 'PENDING_EXTERNAL',
      key: request().key,
      attempt: 1,
      revision: 2,
      report_sha256: REPORT_SHA,
      snapshot: { revision: 4, cutoff: '2026-10-31' },
      form_status: null,
    });
  });

  it('carries the marks of a demo form into the manifest', () => {
    const manifest = hpmManifestOf(request({ copy: { ...request().copy, marks: { formStatus: 'DEMO', demoMark: 'DEMO MARK' } } }));
    expect(manifest).toMatchObject({ form_status: 'DEMO', demo_mark: 'DEMO MARK' });
    expect(hpmManifestOf(request({ copy: { ...request().copy, snapshot: null } })).snapshot).toBeNull();
  });

  it('gives the same bytes for the same request, and the same key with the next attempt number on a re-send', () => {
    expect(buildHpmPackage(request())).toEqual(buildHpmPackage(request()));
    const again = unzipSync(buildHpmPackage(request({ attempt: 2 })));
    const manifest = JSON.parse(strFromU8(again['manifest.json'] as Uint8Array)) as Record<string, unknown>;
    expect(manifest.key).toBe(request().key);
    expect(manifest.attempt).toBe(2);
    expect(buildHpmPackage(request({ attempt: 2 }))).not.toEqual(buildHpmPackage(request()));
  });
});

describe('the file writer (PENDING-EXTERNAL: it stands for HPM and never calls it)', () => {
  it('hands the package to the sink of the tenant and answers where it is, awaiting a receipt', async () => {
    const written: Array<{ tenantId: string; name: string; bytes: Uint8Array }> = [];
    const writer = new HpmFileWriter((tenantId, name, bytes) => {
      written.push({ tenantId, name, bytes });
      return Promise.resolve(`${tenantId}/${name}`);
    });
    const answer = await writer.deliver(request());
    expect(writer.adapterStatus).toBe(HPM_ADAPTER_STATUS);
    expect(writer.packageFormat).toBe(HPM_PACKAGE_FORMAT);
    expect(written).toHaveLength(1);
    expect(answer).toMatchObject({ mode: 'FILE', location: `${request().tenantId}/${hpmPackageName(request().copy)}`, receiver: 'AWAITING_RECEIPT', acceptance: 'PENDING_EXTERNAL', packageFormat: HPM_PACKAGE_FORMAT });
    expect(answer.packageSha256).toBe(createHash('sha256').update(written[0]?.bytes as Uint8Array).digest('hex'));
    expect(answer.packageSize).toBe(written[0]?.bytes.length);
  });

  it('opens no socket and makes no request, whatever it is given', async () => {
    const sockets = jest.spyOn(net.Socket.prototype, 'connect');
    const plain = jest.spyOn(http, 'request');
    const secure = jest.spyOn(https, 'request');
    const lookups = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network is allowed'));
    try {
      await new HpmFileWriter(() => Promise.resolve('here')).deliver(request());
      expect(sockets).not.toHaveBeenCalled();
      expect(plain).not.toHaveBeenCalled();
      expect(secure).not.toHaveBeenCalled();
      expect(lookups).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('lets a failure of the sink through, for the ledger to record as a failed attempt', async () => {
    await expect(new HpmFileWriter(() => Promise.reject(new Error('disk full'))).deliver(request())).rejects.toThrow('disk full');
  });

  it('imports nothing that can reach a network (the source is held to it)', () => {
    const source = readFileSync(join(__dirname, 'hpm-port.ts'), 'utf8');
    expect(source).not.toMatch(/from 'node:(http|https|net|dgram|dns|tls|http2)'/);
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });
});
