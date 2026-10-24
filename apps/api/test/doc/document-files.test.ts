import { createHash } from 'node:crypto';
import { PdfLibRenderer } from '../../src/modules/doc/pdf-renderer';
import { MockCertificateAuthority } from '../../src/modules/doc/mock-pki';
import type { Identity } from '../../src/modules/doc/mock-pki';
import { eicarBytes } from '../../src/modules/files/mock-scan';
import { ADMIN, EXT_CLERK, NOBODY, NOW, TENANT_A, TENANT_B, UNIT_TWO_CLERK } from './doc-app';
import { FlowWorld } from './support/flow-world';
import { signField } from './support/pdf-fixture';
import { sampleRequest } from './render-fixture';

jest.setTimeout(240_000);

const flow = new FlowWorld();
const { app } = flow;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const HOUR = 60 * 60 * 1000;
const SIGNED_AT = new Date(NOW.getTime() - 24 * HOUR);
let base: Buffer;
let stranger: Identity;

async function signedAs(pdf: Uint8Array, field: string, identity: Identity, options: { timestamp?: boolean } = {}): Promise<Buffer> {
  flow.world.setTime(SIGNED_AT);
  try {
    return await signField(pdf, { field, identity, signingTime: SIGNED_AT, ...(options.timestamp === false ? {} : { timestamps: flow.world.tsa }) });
  } finally {
    flow.world.setTime(NOW);
  }
}

const upload = (bytes: Uint8Array, member: number = ADMIN, extra: { tenantId?: string; type?: string; key?: string } = {}) =>
  app.upload('/document-files', { member, bytes, ...extra });

interface SignatureReport {
  role: string;
  status: string;
  chain_status: string;
  signed_at: string | null;
  timestamp_proven: boolean;
  findings: string[];
}

describe('uploadDocumentFile: a PDF into DOC (ST-DOC-009, CR-DOC-01)', () => {
  beforeAll(async () => {
    await flow.start();
    base = Buffer.from((await new PdfLibRenderer().render({ ...sampleRequest(), signatureFields: true })).bytes);
    const strangerCa = await MockCertificateAuthority.createRoot({ commonName: 'Stranger CA', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2040-01-01T00:00:00Z') });
    stranger = await strangerCa.issue({ commonName: 'Somebody Else', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2030-01-01T00:00:00Z') });
  }, 300_000);

  afterAll(() => flow.stop(), 60_000);

  it('stores a signed file under the tenant and answers its hash, its pages and the verdict of each signature', async () => {
    const signed = await signedAs(base, 'sig_leader', flow.world.leader);
    const reply = await upload(signed);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ file_sha256: sha256(signed), size_bytes: signed.length, overall: 'VALID' });
    expect(String(reply.json.file_object_key)).toContain(`tenants/${TENANT_A}/`);
    expect(reply.json.page_count).toBeGreaterThanOrEqual(1);
    const [signature] = reply.json.signatures as SignatureReport[];
    expect(reply.json.signatures).toHaveLength(1);
    expect(signature).toMatchObject({ role: 'LEADER', status: 'VALID', timestamp_proven: true, findings: [] });
    expect(signature?.signed_at).toBe(SIGNED_AT.toISOString());
    // The audit row carries the hash and the counts, never the content.
    expect(await app.count("select count(*) as n from machvon.audit_event where action = 'document.file_uploaded'")).toBeGreaterThanOrEqual(1);
  });

  it('answers the first reply again for the same idempotency key', async () => {
    const signed = await signedAs(base, 'sig_leader', flow.world.leader);
    const key = `key-${'a'.repeat(20)}`;
    const first = await upload(signed, ADMIN, { key });
    const again = await upload(signed, ADMIN, { key });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.json.file_object_key).toBe(first.json.file_object_key);
  });

  it('shows a signature whose time nobody proved, and one from a certificate the tenant does not trust', async () => {
    const untimed = await upload(await signedAs(base, 'sig_leader', flow.world.leader, { timestamp: false }));
    expect(untimed.status).toBe(200);
    const [timeless] = untimed.json.signatures as SignatureReport[];
    expect(timeless?.timestamp_proven).toBe(false);
    expect(timeless?.findings).toContain('SIGNING_TIME_UNPROVEN');
    expect(untimed.json.overall).not.toBe('VALID');

    const foreign = await upload(await signedAs(base, 'sig_leader', stranger));
    expect(foreign.status).toBe(200);
    const [unknown] = foreign.json.signatures as SignatureReport[];
    expect(unknown?.chain_status).not.toBe('TRUSTED');
    expect(foreign.json.overall).not.toBe('VALID');
  });

  it('reads an unsigned PDF as a file with no signatures', async () => {
    const reply = await upload(base);
    expect(reply.status).toBe(200);
    expect(reply.json.signatures).toEqual([]);
    expect(reply.json.file_sha256).toBe(sha256(base));
    expect(reply.json.page_count).toBeGreaterThanOrEqual(1);
  });

  it('reads a file changed after it was signed as INVALID', async () => {
    const signed = Buffer.from(await signedAs(base, 'sig_leader', flow.world.leader));
    const at = signed.indexOf('/Type');
    expect(at).toBeGreaterThan(0);
    signed[at + 1] = 'X'.charCodeAt(0);
    const reply = await upload(signed);
    if (reply.status === 200) {
      expect(reply.json.overall).toBe('INVALID');
      expect((reply.json.signatures as SignatureReport[])[0]?.status).toBe('INVALID');
    } else {
      // A file the reader cannot parse any more is refused as a PDF; either way nothing is read as valid.
      expect(reply.status).toBe(422);
    }
  });

  it('refuses an infected file, a file that is not a PDF, an image (documents take scans as images, DOC takes PDF only), an empty file and a PDF that is only named so', async () => {
    const infected = await upload(Buffer.concat([base, Buffer.from('\n%'), Buffer.from(eicarBytes())]));
    expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
    const text = await upload(new TextEncoder().encode('just some text, not a document'));
    expect(text.status).toBe(422);
    const png = await upload(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), ADMIN, { type: 'image/png' });
    expect([png.status, png.json.code]).toEqual([422, 'UPLOAD_NOT_PDF']);
    expect((await upload(new Uint8Array())).status).toBe(422);
    const named = await upload(new TextEncoder().encode('%PDF-1.7\nthis is not a real file\n'));
    expect(named.status).toBe(422);
    expect(named.json.code).toBe('UPLOAD_NOT_PDF');
  });

  it('judges the scan before the PDF reader touches the file: an infected file that is no readable PDF is infected, not "not a PDF"', async () => {
    // The page reader is a parser of attacker bytes; it runs only on a file the scanner found clean.
    const hostile = await upload(Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Kids [ 1 0 R ] >> endobj\n'), Buffer.from(eicarBytes())]));
    expect([hostile.status, hostile.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
  });

  it('judges the scan before the PDF reader touches a file that is no readable PDF at all: infected is infected, and a clean unreadable file is still not a PDF', async () => {
    const garbage = Buffer.from('%PDF-1.7\nthis is not a real file, only a header and some noise\n');
    const infected = await upload(Buffer.concat([garbage, Buffer.from(eicarBytes())]));
    expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
    const clean = await upload(garbage);
    expect([clean.status, clean.json.code]).toEqual([422, 'UPLOAD_NOT_PDF']);
  });

  it('refuses a file above the limit before reading it', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    expect((await upload(big)).status).toBe(413);
  });

  it('is for a caller who holds doc.file.upload, and for nobody else', async () => {
    expect((await upload(base, EXT_CLERK)).status).toBe(200);
    // A clerk of registers without the permission, and a member with no grant at all, are refused.
    expect((await upload(base, UNIT_TWO_CLERK)).status).toBe(403);
    expect((await upload(base, NOBODY)).status).toBe(403);
    // The same bytes in another tenant are stored under that tenant's keys, never under this one's.
    const other = await upload(base, ADMIN, { tenantId: TENANT_B });
    expect(other.status).toBe(200);
    expect(String(other.json.file_object_key)).toContain(`tenants/${TENANT_B}/`);
  });
});
