import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { assertArchivable, attachmentKindInScope, buildManifest, encryptForCustomer, exportWindowEnd, fileMatchesManifest, isWithinExportWindow, manifestText, offboardingDefects, parseCustomerKey, bytesSha256, splitColumns, tablesToExport } from '../src/index.ts';

const NOW = new Date('2026-10-30T03:00:00Z');
const day = (n: number, from = NOW): Date => new Date(from.getTime() + n * 86_400_000);

describe('offboarding a tenant (ST-SAS-016)', () => {
  const good = { contractEndDate: '2026-12-31', exportWindowDays: 90, reason: 'The contract ends and the province will not renew it.' };

  it('asks for a real contract day, a window of 30 to 180 days and a reason', () => {
    expect(offboardingDefects(good)).toEqual([]);
    expect(offboardingDefects({ ...good, exportWindowDays: 30 })).toEqual([]);
    expect(offboardingDefects({ ...good, exportWindowDays: 180 })).toEqual([]);
    for (const [bad, field] of [
      [{ contractEndDate: '2026-02-31' }, 'contract_end_date'],
      [{ contractEndDate: '31/12/2026' }, 'contract_end_date'],
      [{ exportWindowDays: 29 }, 'export_window_days'],
      [{ exportWindowDays: 181 }, 'export_window_days'],
      [{ exportWindowDays: 45.5 }, 'export_window_days'],
      [{ reason: 'short' }, 'reason'],
    ] as const)
      expect(offboardingDefects({ ...good, ...bad })).toEqual([field]);
  });

  it('opens the window when the contract ends, or when offboarding starts if that is later, and lasts the days agreed', () => {
    expect(exportWindowEnd('2026-12-31', NOW, 90)).toEqual(new Date('2027-04-01T00:00:00Z'));
    expect(exportWindowEnd('2026-01-01', NOW, 30)).toEqual(day(30));
  });

  it('archives only after a delivered export or once the window has ended, and brings a tenant back only inside the window', () => {
    const windowEndsAt = day(30);
    expect(() => assertArchivable({ deliveredExport: false, windowEndsAt }, NOW)).toThrow(expect.objectContaining({ code: 'EXPORT_NOT_CONFIRMED', status: 409 }));
    expect(() => assertArchivable({ deliveredExport: false, windowEndsAt: null }, NOW)).toThrow(expect.objectContaining({ code: 'EXPORT_NOT_CONFIRMED' }));
    expect(() => assertArchivable({ deliveredExport: true, windowEndsAt }, NOW)).not.toThrow();
    expect(() => assertArchivable({ deliveredExport: false, windowEndsAt }, day(30))).not.toThrow();
    expect(isWithinExportWindow(windowEndsAt, day(29))).toBe(true);
    expect(isWithinExportWindow(windowEndsAt, day(30))).toBe(false);
  });
});

describe('the export of the data of a tenant (ST-SAS-016)', () => {
  const tables = ['audit_event', 'contract', 'idempotency_record', 'membership', 'outbox_event', 'project', 'user_session', 'tenant_export_job', 'role_grant', 'notification_instance', 'legal_hold', 'boq_line'];

  it('holds every table of the tenant but the machinery and the secrets, and a business-data export leaves out who may do what and what was done', () => {
    expect(tablesToExport(tables, 'FULL')).toEqual(['audit_event', 'boq_line', 'contract', 'legal_hold', 'membership', 'notification_instance', 'project', 'role_grant']);
    expect(tablesToExport(tables, 'BUSINESS_DATA_ONLY')).toEqual(['boq_line', 'contract', 'project']);
  });

  it('leaves the files of the audit trail out of a business-data export, as it leaves out its tables', () => {
    expect([attachmentKindInScope('audit_export', 'FULL'), attachmentKindInScope('audit_export', 'BUSINESS_DATA_ONLY'), attachmentKindInScope('report_export', 'BUSINESS_DATA_ONLY'), attachmentKindInScope('logo', 'BUSINESS_DATA_ONLY')]).toEqual([true, false, true, true]);
  });

  it('leaves out the columns that hold a secret and says which', () => {
    expect(splitColumns(['id', 'name', 'push_secret_ref', 'token_fingerprint', 'api_key_ref', 'status'])).toEqual({ kept: ['id', 'name', 'status'], omitted: ['push_secret_ref', 'token_fingerprint', 'api_key_ref'] });
  });

  it('lists every file with its size and hash, counts the rows by table, and the owner can check a file against it', () => {
    const data = Buffer.from('{"id":1}\n{"id":2}\n');
    const manifest = buildManifest({
      job_id: 'job',
      tenant_id: 'tenant',
      scope: 'FULL',
      snapshot_at: NOW.toISOString(),
      files: [
        { path: 'tables/project.jsonl', bytes: data.length, sha256: bytesSha256(data), table: 'project', rows: 2 },
        { path: 'tables/contract.jsonl', bytes: 0, sha256: bytesSha256(Buffer.alloc(0)), table: 'contract', rows: 0 },
      ],
      omitted_columns: {},
      missing_files: [],
      withheld_files: [],
      unreadable_tables: [],
      encryption_key_fingerprint: null,
    });
    expect(manifest.files.map((file) => file.path)).toEqual(['tables/contract.jsonl', 'tables/project.jsonl']);
    expect(manifest.row_counts).toEqual({ contract: 0, project: 2 });
    expect(fileMatchesManifest(manifest, 'tables/project.jsonl', data)).toBe(true);
    expect(fileMatchesManifest(manifest, 'tables/project.jsonl', Buffer.from('{"id":1}\n'))).toBe(false);
    expect(fileMatchesManifest(manifest, 'tables/other.jsonl', data)).toBe(false);
    expect(manifestText(manifest)).toBe(manifestText(JSON.parse(manifestText(manifest))));
  });

  it('encrypts a file for the customer so that only their private key opens it, and refuses a key that is not an RSA key of 2048 bits', () => {
    const pem = { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } } as const;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, ...pem }) as unknown as { publicKey: string; privateKey: string };
    const key = parseCustomerKey(pair.publicKey);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const plain = Buffer.from('{"secret":"business data"}\n');
    const { stored, encryption } = encryptForCustomer(plain, key);
    expect(stored.includes(plain)).toBe(false);
    expect(encryption.plaintext_sha256).toBe(bytesSha256(plain));
    const fileKey = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(encryption.wrapped_key, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', fileKey, stored.subarray(0, 12));
    decipher.setAuthTag(stored.subarray(12, 28));
    expect(Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).equals(plain)).toBe(true);
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024, ...pem }) as unknown as { publicKey: string };
    const curve = generateKeyPairSync('ec', { namedCurve: 'P-256', ...pem }) as unknown as { publicKey: string };
    // A private key is refused outright, and a public key is kept as the parser exports it: nothing the customer pasted around it is stored.
    expect(() => parseCustomerKey(pair.privateKey)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'encryption_public_key_pem' }));
    expect(parseCustomerKey(`  ${pair.publicKey}  \n`).pem).toBe(pair.publicKey);
    expect(key.pem).not.toContain('PRIVATE');
    for (const bad of ['not a key', weak.publicKey, curve.publicKey]) {
      expect(() => parseCustomerKey(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail: 'encryption_public_key_pem' }));
    }
  });
});
