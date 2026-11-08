import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { RESTORE_RPO_TARGET_SECONDS, RESTORE_RTO_TARGET_SECONDS } from '@machvon/kernel';
import type { Measurement } from '@machvon/kernel';
import { compareDrill, drillReportReference, fileReferenceSummary, manifestReference, measureTenants } from '../src/restore-drill';
import type { DrillManifest, DrillTimings } from '../src/restore-drill';
import { main } from '../src/restore-drill-cli';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const START = new Date('2026-11-08T01:00:00Z');
const POINT = new Date('2026-11-08T00:55:00Z');
const timings = (overrides: Partial<DrillTimings> = {}): DrillTimings => ({ recoveryPoint: POINT, restoredTo: POINT, startedAt: START, verifiedAt: new Date(START.getTime() + 2 * 3_600_000), ...overrides });

const measurement = (rows = 3, money = '1500'): Measurement => ({ tables: { note: { rows, checksum: `c${rows}`, money: { amount_vnd: money } }, plain: { rows: 1, checksum: 'p', money: {} } } });
const manifest = (role: DrillManifest['role'], tenants: Record<string, Measurement>, files?: DrillManifest['files']): DrillManifest => ({ schemaVersion: 1, role, takenAt: '2026-11-08T00:00:00.000Z', tenants, ...(files === undefined ? {} : { files }) });

describe('the restore drill of the cluster reuses the tenant restore comparison (docs/runbooks/infra/restore-drill.md)', () => {
  describe('compare', () => {
    const source = manifest('source', { [TENANT_A]: measurement(), [TENANT_B]: measurement(5, '99') });

    it('matches when every tenant has the same tables, rows, checksums and money, and states the RPO and RTO against the targets', () => {
      const report = compareDrill(source, manifest('restored', structuredClone(source.tenants)), timings());
      expect(report.matched).toBe(true);
      expect(report.mismatches).toEqual([]);
      expect(report.tenants.map((entry) => [entry.tenant_id, entry.matched, entry.rows_expected, entry.rows_restored])).toEqual([[TENANT_A, true, 4, 4], [TENANT_B, true, 6, 6]]);
      expect(report.tenants[0]?.money_expected_vnd).toBe('1500');
      expect(report.tenants[0]?.reference).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.rpo_seconds).toBe(0);
      expect(report.rto_seconds).toBe(7200);
      expect(report.rpo_target_seconds).toBe(RESTORE_RPO_TARGET_SECONDS);
      expect(report.rto_target_seconds).toBe(RESTORE_RTO_TARGET_SECONDS);
      expect(report.within_targets).toBe(true);
    });

    it('names the tenant and the difference: a row lost, a checksum changed, a money total changed, a table lost or added', () => {
      const restoredTenants = structuredClone(source.tenants);
      restoredTenants[TENANT_A] = { tables: { note: { rows: 2, checksum: 'other', money: { amount_vnd: '1499' } }, extra: { rows: 0, checksum: '', money: {} } } };
      const report = compareDrill(source, manifest('restored', restoredTenants), timings());
      expect(report.matched).toBe(false);
      expect(report.mismatches).toEqual(
        expect.arrayContaining([`${TENANT_A}:rows:note`, `${TENANT_A}:checksum:note`, `${TENANT_A}:money:note.amount_vnd`, `${TENANT_A}:missing_table:plain`, `${TENANT_A}:unexpected_table:extra`]),
      );
      expect(report.tenants.find((entry) => entry.tenant_id === TENANT_B)?.matched).toBe(true);
    });

    it('reports a tenant that is missing from the restored cluster and one that should not be there', () => {
      const restoredTenants = { [TENANT_A]: measurement(), '00000000-0000-4000-8000-0000000000cc': measurement() };
      const report = compareDrill(source, manifest('restored', restoredTenants), timings());
      expect(report.matched).toBe(false);
      expect(report.missing_tenants).toEqual([TENANT_B]);
      expect(report.unexpected_tenants).toEqual(['00000000-0000-4000-8000-0000000000cc']);
      expect(report.mismatches).toEqual(expect.arrayContaining([`missing_tenant:${TENANT_B}`, 'unexpected_tenant:00000000-0000-4000-8000-0000000000cc']));
    });

    it('compares the file references when both manifests carry them, and treats one without the other as a difference', () => {
      const files = fileReferenceSummary(['b/2', 'a/1', 'a/1', '']);
      expect(files.references).toBe(2);
      expect(fileReferenceSummary(['a/1', 'b/2'])).toEqual(files);
      const same = compareDrill(manifest('source', {}, files), manifest('restored', {}, fileReferenceSummary(['a/1', 'b/2'])), timings());
      expect(same.files.match).toBe(true);
      expect(same.matched).toBe(true);
      const lost = compareDrill(manifest('source', {}, files), manifest('restored', {}, fileReferenceSummary(['a/1'])), timings());
      expect(lost.matched).toBe(false);
      expect(lost.mismatches).toEqual(['file_references']);
      const oneSided = compareDrill(manifest('source', {}, files), manifest('restored', {}), timings());
      expect(oneSided.mismatches).toEqual(['file_references']);
      expect(compareDrill(manifest('source', {}), manifest('restored', {}), timings()).files).toEqual({ expected: null, restored: null, match: true });
    });

    it('matches but is outside the targets when the restore stopped too early or took too long', () => {
      const restored = manifest('restored', structuredClone(source.tenants));
      const early = compareDrill(source, restored, timings({ restoredTo: new Date(POINT.getTime() - 20 * 60_000) }));
      expect(early.matched).toBe(true);
      expect(early.rpo_seconds).toBe(1200);
      expect(early.within_targets).toBe(false);
      const slow = compareDrill(source, restored, timings({ verifiedAt: new Date(START.getTime() + 5 * 3_600_000) }));
      expect(slow.matched).toBe(true);
      expect(slow.rto_seconds).toBe(18_000);
      expect(slow.within_targets).toBe(false);
    });

    it('names the manifests and the report by the sha256 of their canonical text, so a changed value changes the reference', () => {
      const restored = manifest('restored', structuredClone(source.tenants));
      const report = compareDrill(source, restored, timings());
      expect(report.source_manifest).toBe(manifestReference(source));
      expect(report.restored_manifest).toBe(manifestReference(restored));
      expect(drillReportReference(report)).toMatch(/^sha256:[0-9a-f]{64}$/);
      const changed = structuredClone(restored);
      (changed.tenants[TENANT_A] as { tables: Record<string, { rows: number }> }).tables.note!.rows = 99;
      expect(manifestReference(changed)).not.toBe(manifestReference(restored));
      expect(drillReportReference(compareDrill(source, changed, timings()))).not.toBe(drillReportReference(report));
    });
  });

  describe('against a real database', () => {
    const harness = new AuthzHarness();
    const scratch: string[] = [];
    const directory = (): string => {
      const path = mkdtempSync(join(tmpdir(), 'machvon-drill-'));
      scratch.push(path);
      return path;
    };
    const admin = async (text: string, params: unknown[] = []): Promise<void> => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query(text, params);
      } finally {
        await client.end();
      }
    };
    const lines: string[] = [];
    const io = { log: (line: string) => void lines.push(line) };
    const env = () => ({ DATABASE_URL_APP: harness.database.urlFor('machvon_app'), DATABASE_URL_CONTROL: harness.database.urlFor('machvon_control') });

    beforeAll(async () => {
      await harness.start();
      await admin('create table machvon.drill_probe (tenant_id uuid not null, id uuid not null, label text not null, amount_vnd numeric(24,0) not null default 0, primary key (tenant_id, id))');
      await admin('alter table machvon.drill_probe enable row level security');
      await admin('alter table machvon.drill_probe force row level security');
      await admin("create policy tenant_boundary on machvon.drill_probe using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)");
      await admin('grant select, insert, update, delete on machvon.drill_probe to machvon_app');
      await admin("insert into machvon.drill_probe (tenant_id, id, label, amount_vnd) values ($1, '00000000-0000-4000-8000-000000000001', 'a', 1000), ($1, '00000000-0000-4000-8000-000000000002', 'b', 2500)", [TENANT_A]);
    }, 180_000);

    afterAll(async () => {
      for (const path of scratch) rmSync(path, { recursive: true, force: true });
      await harness.stop();
    }, 60_000);

    it('measures every tenant with the measure of the tenant restore and compares a cluster with itself as matching', async () => {
      const first = await measureTenants(harness.tenants, [TENANT_B, TENANT_A], 'source');
      const second = await measureTenants(harness.tenants, [TENANT_A, TENANT_B], 'restored');
      expect(Object.keys(first.tenants)).toEqual([TENANT_A, TENANT_B].sort());
      expect(first.tenants[TENANT_A]?.tables.drill_probe).toMatchObject({ rows: 2, money: { amount_vnd: '3500' } });
      expect(first.tenants[TENANT_B]?.tables.drill_probe).toMatchObject({ rows: 0 });
      const report = compareDrill(first, second, timings());
      expect(report.matched).toBe(true);
    });

    it('sees a restored copy that lost a row or changed an amount, through the same comparison', async () => {
      const before = await measureTenants(harness.tenants, [TENANT_A], 'source');
      await admin("update machvon.drill_probe set amount_vnd = 2499 where tenant_id = $1 and id = '00000000-0000-4000-8000-000000000002'", [TENANT_A]);
      const changed = await measureTenants(harness.tenants, [TENANT_A], 'restored');
      expect(compareDrill(before, changed, timings()).mismatches).toEqual(expect.arrayContaining([`${TENANT_A}:checksum:drill_probe`, `${TENANT_A}:money:drill_probe.amount_vnd`]));
      await admin("delete from machvon.drill_probe where tenant_id = $1 and id = '00000000-0000-4000-8000-000000000002'", [TENANT_A]);
      const lost = await measureTenants(harness.tenants, [TENANT_A], 'restored');
      expect(compareDrill(before, lost, timings()).mismatches).toEqual(expect.arrayContaining([`${TENANT_A}:rows:drill_probe`]));
      await admin("insert into machvon.drill_probe (tenant_id, id, label, amount_vnd) values ($1, '00000000-0000-4000-8000-000000000002', 'b', 2500)", [TENANT_A]);
    });

    it('the command line takes two manifests and a comparison: exit 0 for a match, 1 for a difference, 3 for a miss of the targets, 2 for a wrong call', async () => {
      const dir = directory();
      const files = join(dir, 'files.txt');
      writeFileSync(files, 'obj/1\nobj/2\n');
      const flags = (role: string, out: string) => ['measure', '--role', role, '--out', join(dir, out), '--tenants', `${TENANT_A},${TENANT_B}`, '--files-list', files];
      expect(await main(flags('source', 'source.json'), env(), io)).toBe(0);
      expect(await main(flags('restored', 'restored.json'), env(), io)).toBe(0);
      expect(lines.some((line) => /^sha256 [0-9a-f]{64} {2}/.test(line))).toBe(true);
      const stored = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as DrillManifest;
      expect(stored.files?.references).toBe(2);
      const compare = (overrides: Record<string, string> = {}, out = 'report.json') => {
        const values = { '--source': join(dir, 'source.json'), '--restored': join(dir, 'restored.json'), '--recovery-point': POINT.toISOString(), '--restored-to': POINT.toISOString(), '--started-at': START.toISOString(), '--verified-at': new Date(START.getTime() + 3_600_000).toISOString(), '--out': join(dir, out), ...overrides };
        return main(['compare', ...Object.entries(values).flat()], env(), io);
      };
      expect(await compare()).toBe(0);
      expect(lines).toContain('VERDICT: matches and meets the targets');
      expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).matched).toBe(true);
      expect(await compare({ '--verified-at': new Date(START.getTime() + 6 * 3_600_000).toISOString() })).toBe(3);
      writeFileSync(files, 'obj/1\n');
      expect(await main(flags('restored', 'restored.json'), env(), io)).toBe(0);
      expect(await compare()).toBe(1);
      expect(lines).toContain('MISMATCH file_references');
      expect(lines).toContain('VERDICT: the restore does NOT match the source');
      expect(await compare({ '--source': join(dir, 'missing.json') })).toBe(2);
      expect(await compare({ '--verified-at': 'not a date' })).toBe(2);
    });

    it('the command line refuses a wrong call without touching a database', async () => {
      const quiet = { log: () => undefined };
      expect(await main([], {}, quiet)).toBe(2);
      expect(await main(['--nonsense'], {}, quiet)).toBe(2);
      expect(await main(['measure', '--role', 'source', '--out', join(directory(), 'x.json')], {}, quiet)).toBe(2);
      expect(await main(['measure', '--role', 'neither', '--out', 'x.json'], env(), quiet)).toBe(2);
    });

    it('measures the registered tenants and the platform tenant when no tenant list is given', async () => {
      const dir = directory();
      expect(await main(['measure', '--role', 'source', '--out', join(dir, 'all.json')], env(), io)).toBe(0);
      const all = JSON.parse(readFileSync(join(dir, 'all.json'), 'utf8')) as DrillManifest;
      expect(Object.keys(all.tenants)).toContain('00000000-0000-4000-8000-0000000000aa');
    });
  });
});
