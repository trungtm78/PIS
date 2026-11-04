import type { Client } from 'pg';
import { AuditExportStore } from '../src/audit-export-store';
import type { AuditExportRequest } from '../src/audit-export-store';
import { CSV_COLUMNS, verifyAuditExport } from '../src/audit-export-format';
import type { ExportFormat } from '../src/audit-export-format';
import { AuditSealJob, SEAL_CHECK_STALE_SECONDS, readSealCheck } from '../src/audit-seal-job';
import { MEMBERSHIP, RESOURCE, TENANT_A, TENANT_B, contextOf, ownerSession, startAuditHarness } from './support/audit-fixtures';
import type { AuditHarness } from './support/audit-fixtures';

const BASE = Date.parse('2026-03-01T10:00:00.000Z');
const minute = (n: number): string => new Date(BASE + n * 60_000).toISOString();
const MAX_BYTES = 64 * 1024 * 1024;
const REDACTED = '[REDACTED]';

type Planted = { n: number; resourceType?: string; diff?: Record<string, unknown>; reason?: string | null };

describe('AuditExportStore and the kept verdict of the seal verification (ST-ADM-016)', () => {
  let harness: AuditHarness;
  let owners: Record<string, Client>;
  const store = new AuditExportStore();

  const plant = async (tenant: string, row: Planted): Promise<void> => {
    await (owners[tenant] as Client).query(
      `insert into machvon.audit_event
         (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, reason, correlation_id, request_id, occurred_at, ip_hash)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::jsonb, $7, $5, $5, $8::timestamptz, $9)`,
      [tenant, MEMBERSHIP, `plant.${tenant === TENANT_A ? 'a' : 'b'}.${row.n}`, row.resourceType ?? 'widget', RESOURCE, JSON.stringify(row.diff ?? { n: row.n }), row.reason ?? null, minute(row.n), 'a'.repeat(64)],
    );
  };

  /** Rows 1..count a minute apart; odd rows are widgets, even rows gadgets. */
  const plantRows = async (tenant: string, count: number, from = 1): Promise<void> => {
    for (let n = from; n < from + count; n += 1) await plant(tenant, { n, resourceType: n % 2 === 1 ? 'widget' : 'gadget' });
  };

  const sealAll = (windowRows: number, tenant = TENANT_A) => new AuditSealJob(harness.tenantDatabase, { windowRows }).seal(contextOf(tenant));

  const request = (overrides: Partial<AuditExportRequest> = {}): AuditExportRequest => ({
    tenantId: TENANT_A,
    from: new Date(minute(0)),
    to: new Date(minute(5000)),
    resourceTypes: undefined,
    format: 'JSONL',
    maxBytes: MAX_BYTES,
    generatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  });

  const exportOf = (overrides: Partial<AuditExportRequest> = {}, tenant = TENANT_A) =>
    harness.tenantDatabase.withTenant(contextOf(tenant), (tx) => store.build(tx, request({ tenantId: tenant, ...overrides })));

  const linesOf = (text: string): Array<Record<string, unknown>> =>
    text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const clear = async (tenant: string): Promise<void> => {
    const owner = owners[tenant] as Client;
    await owner.query('delete from machvon.audit_seal_check');
    await owner.query('delete from machvon.audit_seal');
    await owner.query('delete from machvon.audit_event');
  };

  beforeAll(async () => {
    harness = await startAuditHarness();
    owners = { [TENANT_A]: await ownerSession(harness, TENANT_A), [TENANT_B]: await ownerSession(harness, TENANT_B) };
  }, 180_000);

  afterAll(async () => {
    if (owners) await Promise.all(Object.values(owners).map((owner) => owner.end()));
    if (harness) await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    await clear(TENANT_A);
    await clear(TENANT_B);
  });

  describe('the sealed export', () => {
    it('cuts a period out of the trail with every seal that touches it and the hashes of the other rows of those windows, and a recipient verifies it alone (AC-ST-ADM-016-1)', async () => {
      await plantRows(TENANT_A, 25);
      await sealAll(10);
      // Rows 5..15 (the end is exclusive: row 16 is at the end minute and is not an event).
      const file = await exportOf({ from: new Date(minute(5)), to: new Date(minute(16)) });
      expect(file).toMatchObject({ events: 11, leafOnly: 9, seals: 2, unsealedEvents: 0 });
      const records = linesOf(file.text);
      expect(records[0]).toMatchObject({ record_type: 'MANIFEST', format_version: 1, tenant_id: TENANT_A, events: 11, leaf_only: 9, seals: 2, unsealed_events: 0, resource_types: null });
      expect(records.filter((record) => record.record_type === 'SEAL')).toHaveLength(2);
      expect(records.filter((record) => record.record_type === 'EVENT').map((record) => record.action)).toEqual(Array.from({ length: 11 }, (_, index) => `plant.a.${index + 5}`));
      expect(records.filter((record) => record.record_type === 'LEAF')).toHaveLength(9);
      expect(verifyAuditExport(file.text, 'JSONL')).toEqual({ ok: true, findings: [], seals: 2, events: 11, leafOnly: 9, unsealedEvents: 0, boundEvents: 11 });
    });

    it('exports only the asked resource types as events, the other rows of the windows as leaves, and still verifies', async () => {
      await plantRows(TENANT_A, 20);
      await sealAll(10);
      const file = await exportOf({ resourceTypes: ['gadget'] });
      expect(file).toMatchObject({ events: 10, leafOnly: 10, seals: 2 });
      const events = linesOf(file.text).filter((record) => record.record_type === 'EVENT');
      expect(events.every((record) => record.resource_type === 'gadget')).toBe(true);
      expect(verifyAuditExport(file.text, 'JSONL').ok).toBe(true);
    });

    it('carries rows that are not sealed yet as events with no seal, and says how many', async () => {
      await plantRows(TENANT_A, 10);
      await sealAll(10);
      await plantRows(TENANT_A, 3, 11);
      const file = await exportOf();
      expect(file).toMatchObject({ events: 13, seals: 1, unsealedEvents: 3 });
      const events = linesOf(file.text).filter((record) => record.record_type === 'EVENT');
      expect(events.filter((record) => record.seal_id === null)).toHaveLength(3);
      expect(verifyAuditExport(file.text, 'JSONL')).toMatchObject({ ok: true, unsealedEvents: 3 });
    });

    it('exports a trail that was never sealed as events alone', async () => {
      await plantRows(TENANT_A, 4);
      const file = await exportOf();
      expect(file).toMatchObject({ events: 4, leafOnly: 0, seals: 0, unsealedEvents: 4 });
      expect(verifyAuditExport(file.text, 'JSONL').ok).toBe(true);
    });

    it('writes a manifest and nothing else for a period with no rows', async () => {
      await plantRows(TENANT_A, 3);
      await sealAll(10);
      const file = await exportOf({ from: new Date(minute(500)), to: new Date(minute(600)) });
      expect(file).toMatchObject({ events: 0, leafOnly: 0, seals: 0 });
      expect(linesOf(file.text)).toHaveLength(1);
      expect(linesOf(file.text)[0]).toMatchObject({ record_type: 'MANIFEST', first_seq: null, last_seq: null });
      expect(verifyAuditExport(file.text, 'JSONL').ok).toBe(true);
    });

    it('never carries a row of another tenant', async () => {
      await plantRows(TENANT_A, 5);
      await plantRows(TENANT_B, 5);
      await sealAll(10);
      await sealAll(10, TENANT_B);
      const file = await exportOf();
      expect(file.text).not.toContain('plant.b.');
      expect(file.events).toBe(5);
      expect(verifyAuditExport(file.text, 'JSONL').ok).toBe(true);
    });

    it('writes the same records as CSV with a header, quotes what needs it and neutralises a cell that a spreadsheet would run', async () => {
      await plant(TENANT_A, { n: 1, reason: '=HYPERLINK("http://example.invalid")' });
      await plant(TENANT_A, { n: 2, reason: 'line one,\nline "two"' });
      await plantRows(TENANT_A, 8, 3);
      await sealAll(10);
      const file = await exportOf({ format: 'CSV' });
      expect(file.text.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
      expect(file.text).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
      expect(file.text).toContain('"line one,\nline ""two"""');
      expect(verifyAuditExport(file.text, 'CSV')).toMatchObject({ ok: true, seals: 1, events: 10, boundEvents: 0 });
    });

    it('keeps a value that a writer forgot to redact out of the file, marks the row, and the window still verifies', async () => {
      await plant(TENANT_A, { n: 1, diff: { password: 'hunter2', note: 'kept' } });
      await plantRows(TENANT_A, 4, 2);
      await sealAll(10);
      const file = await exportOf();
      expect(file.text).not.toContain('hunter2');
      const event = linesOf(file.text).find((record) => record.action === 'plant.a.1');
      expect(event).toMatchObject({ redacted: true, safe_diff: { password: REDACTED, note: 'kept' } });
      expect(verifyAuditExport(file.text, 'JSONL')).toMatchObject({ ok: true, boundEvents: 4 });
    });

    it('refuses a file that would grow past the limit with 422 EXPORT_RANGE_TOO_LARGE', async () => {
      await plantRows(TENANT_A, 30);
      await sealAll(10);
      await expect(exportOf({ maxBytes: 2000 })).rejects.toMatchObject({ code: 'EXPORT_RANGE_TOO_LARGE', status: 422 });
      await expect(exportOf({ maxBytes: 100 })).rejects.toMatchObject({ code: 'EXPORT_RANGE_TOO_LARGE', status: 422 });
    });

    it('pages through a long trail without losing or doubling a row', async () => {
      await plantRows(TENANT_A, 2105);
      await sealAll(500);
      const file = await exportOf();
      expect(file).toMatchObject({ events: 2105, leafOnly: 0, seals: 5, unsealedEvents: 0 });
      const seqs = linesOf(file.text)
        .filter((record) => record.record_type === 'EVENT')
        .map((record) => Number(record.seq));
      expect(new Set(seqs).size).toBe(2105);
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
      expect(verifyAuditExport(file.text, 'JSONL')).toMatchObject({ ok: true, findings: [], unsealedEvents: 0 });
    }, 120_000);
  });

  describe('what a recipient notices (verifyAuditExport)', () => {
    const exported = async (format: ExportFormat = 'JSONL'): Promise<string> => {
      await plantRows(TENANT_A, 30);
      await sealAll(10);
      return (await exportOf({ from: new Date(minute(5)), to: new Date(minute(26)), format })).text;
    };
    const rewrite = (text: string, change: (records: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): string =>
      `${change(linesOf(text)).map((record) => JSON.stringify(record)).join('\n')}\n`;
    const codes = (text: string): string[] => verifyAuditExport(text, 'JSONL').findings.map((finding) => finding.code);

    it('finds an event whose content was altered', async () => {
      const text = rewrite(await exported(), (records) => records.map((record) => (record.action === 'plant.a.8' ? { ...record, action: 'plant.a.999' } : record)));
      expect(verifyAuditExport(text, 'JSONL').findings).toEqual([{ code: 'EVENT_LEAF_MISMATCH', seq: expect.any(Number) }]);
    });

    it('finds a row that was removed, whether it was an event or a leaf', async () => {
      const text = await exported();
      expect(codes(rewrite(text, (records) => records.filter((record) => record.action !== 'plant.a.8')))).toEqual(expect.arrayContaining(['ROOT_MISMATCH', 'COUNT_MISMATCH']));
      let dropped = false;
      expect(
        codes(
          rewrite(text, (records) =>
            records.filter((record) => {
              if (record.record_type !== 'LEAF' || dropped) return true;
              dropped = true;
              return false;
            }),
          ),
        ),
      ).toContain('ROOT_MISMATCH');
    });

    it('finds a seal whose hash or root was changed and a chain that was cut', async () => {
      const text = await exported();
      expect(codes(rewrite(text, (records) => records.map((record) => (record.record_type === 'SEAL' && record.from_seq === Math.min(...records.filter((r) => r.record_type === 'SEAL').map((r) => Number(r.from_seq))) ? { ...record, seal_hash: 'f'.repeat(64) } : record))))).toContain('SEAL_HASH_MISMATCH');
      expect(codes(rewrite(text, (records) => records.map((record) => (record.record_type === 'SEAL' ? { ...record, merkle_root: '0'.repeat(64) } : record))))).toContain('ROOT_MISMATCH');
      const cut = codes(rewrite(text, (records) => records.map((record, index) => (record.record_type === 'SEAL' && index === 2 ? { ...record, prev_seal_hash: 'e'.repeat(64) } : record))));
      expect(cut).toContain('CHAIN_LINK_MISMATCH');
    });

    it('finds seals out of order, a missing manifest and a manifest that does not match the file', async () => {
      const text = await exported();
      expect(codes(rewrite(text, (records) => records.filter((record) => record.record_type !== 'MANIFEST')))).toEqual(['MANIFEST_MISSING']);
      expect(codes(rewrite(text, (records) => records.map((record) => (record.record_type === 'MANIFEST' ? { ...record, events: 1 } : record))))).toEqual(['COUNT_MISMATCH']);
      expect(
        codes(
          rewrite(text, (records) => {
            const seals = records.filter((record) => record.record_type === 'SEAL');
            return records.map((record) => (record === seals[1] ? { ...seals[0], seal_hash: record.seal_hash } : record));
          }),
        ),
      ).toContain('SEAL_ORDER');
    });

    it('finds the same alterations in the CSV form where the leaves and the chain can be checked', async () => {
      const text = await exported('CSV');
      const lines = text.split('\n');
      const target = lines.findIndex((line) => line.startsWith('LEAF,'));
      const altered = lines.map((line, index) => (index === target ? line.replace(/[0-9a-f]{64}/, '1'.repeat(64)) : line)).join('\n');
      expect(verifyAuditExport(altered, 'CSV').findings.map((finding) => finding.code)).toContain('ROOT_MISMATCH');
    });
  });

  describe('the kept verdict of the verification', () => {
    const verdict = (tenant = TENANT_A) => harness.tenantDatabase.withTenant(contextOf(tenant), (tx) => readSealCheck(tx));
    const verify = (tenant = TENANT_A) => new AuditSealJob(harness.tenantDatabase, { windowRows: 10 }).verify(contextOf(tenant));

    it('is UNKNOWN until the verifier has run, and OK with the number of seals after a clean run (AC-ST-ADM-016-3)', async () => {
      await plantRows(TENANT_A, 25);
      await sealAll(10);
      expect(await verdict()).toEqual({ status: 'UNKNOWN', checkedAt: null, seals: null, broken: null });
      await verify();
      expect(await verdict()).toMatchObject({ status: 'OK', seals: 3, broken: null, checkedAt: expect.stringMatching(/Z$/) });
    });

    it('says BROKEN, with the window, once a run finds a row altered, and OK again when a later run finds it whole', async () => {
      await plantRows(TENANT_A, 25);
      await sealAll(10);
      await verify();
      const owner = owners[TENANT_A] as Client;
      await owner.query("update machvon.audit_event set action = 'tampered' where action = 'plant.a.12'");
      await verify();
      const broken = await verdict();
      expect(broken).toMatchObject({ status: 'BROKEN', broken: { reason: 'ROOT_MISMATCH' } });
      expect(broken.broken?.fromSeq).toBeLessThanOrEqual(broken.broken?.toSeq as number);
      await owner.query("update machvon.audit_event set action = 'plant.a.12' where action = 'tampered'");
      await verify();
      expect(await verdict()).toMatchObject({ status: 'OK', broken: null });
      expect((await owner.query('select count(*)::int as n from machvon.audit_seal_check')).rows[0]).toEqual({ n: 1 });
    });

    it('is STALE when the verifier has missed three runs, and a broken verdict stays BROKEN however old it is', async () => {
      await plantRows(TENANT_A, 5);
      await sealAll(10);
      await verify();
      const owner = owners[TENANT_A] as Client;
      await owner.query('update machvon.audit_seal_check set checked_at = now() - make_interval(secs => $1)', [SEAL_CHECK_STALE_SECONDS + 60]);
      expect(await verdict()).toMatchObject({ status: 'STALE', broken: null });
      await owner.query("update machvon.audit_event set action = 'tampered' where action = 'plant.a.2'");
      await verify();
      await owner.query('update machvon.audit_seal_check set checked_at = now() - make_interval(secs => $1)', [SEAL_CHECK_STALE_SECONDS * 10]);
      expect((await verdict()).status).toBe('BROKEN');
    });

    it('is the verdict of the tenant alone', async () => {
      await plantRows(TENANT_A, 5);
      await sealAll(10);
      await verify();
      expect((await verdict(TENANT_B)).status).toBe('UNKNOWN');
    });
  });
});
