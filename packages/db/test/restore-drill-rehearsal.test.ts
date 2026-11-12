import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import type { DrillManifest, DrillReport } from '../src/restore-drill';
import { main } from '../src/restore-drill-cli';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

/**
 * The scripted rehearsal of the restore drill (YCK.06, `docs/runbooks/infra/restore-drill.md`, section "Rehearsal on one machine"). It runs the real drill commands, `measure` on the source and `measure` on the restored
 * copy and then `compare`, against the embedded PostgreSQL of the test setup. The restore step is a file level copy of the database (`CREATE DATABASE ... TEMPLATE`, the closest thing to a restore that needs no
 * pgBackRest and no second site), so what is rehearsed is everything around it: the manifests, the checksums, the money totals, the file references, the RPO and RTO arithmetic, the verdict and the exit codes, and that a
 * restore that lost data is told apart from one that did not. The files it leaves (`RESTORE_REHEARSAL_OUT`, default a temporary folder) are practice: a rehearsal is not evidence and the ledger of the drills refuses it.
 *   npm run restore:rehearse
 */

const OUT = process.env.RESTORE_REHEARSAL_OUT;
const FILES = ['tenant/a/contract-1.pdf', 'tenant/a/contract-2.pdf', 'tenant/b/decision-9.pdf'];
const rows = [
  [TENANT_A, '00000000-0000-4000-8000-0000000000a1', 'advance', 1000],
  [TENANT_A, '00000000-0000-4000-8000-0000000000a2', 'payment', 2500],
  [TENANT_B, '00000000-0000-4000-8000-0000000000b1', 'payment', 99],
] as const;

describe('the restore drill rehearsed on one machine, with the real drill commands (YCK.06)', () => {
  const harness = new AuthzHarness();
  const scratch: string[] = [];
  const lines: string[] = [];
  const io = { log: (line: string) => void lines.push(line) };
  const sourceName = (): string => new URL(harness.database.adminUrl).pathname.slice(1);
  const urlOn = (url: string, database: string): string => {
    const moved = new URL(url);
    moved.pathname = `/${database}`;
    return moved.toString();
  };
  const withClient = async (url: string, work: (client: Client) => Promise<void>): Promise<void> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await work(client);
    } finally {
      await client.end();
    }
  };
  const envOn = (database: string) => ({ DATABASE_URL_APP: urlOn(harness.database.urlFor('machvon_app'), database), DATABASE_URL_CONTROL: urlOn(harness.database.urlFor('machvon_control'), database) });
  const folder = (): string => {
    const path = OUT === undefined ? mkdtempSync(join(tmpdir(), 'machvon-rehearsal-')) : OUT;
    if (OUT === undefined) scratch.push(path);
    mkdirSync(path, { recursive: true });
    return path;
  };

  /** The restore of the rehearsal: a copy of the source database, taken while nobody is connected to it. */
  async function restoreInto(name: string): Promise<void> {
    await withClient(urlOn(harness.database.adminUrl, 'postgres'), async (client) => {
      await client.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [sourceName()]);
      await client.query(`create database ${name} template ${sourceName()}`);
    });
  }

  beforeAll(async () => {
    await harness.start();
    await withClient(harness.database.adminUrl, async (client) => {
      await client.query('create table machvon.rehearsal_ledger (tenant_id uuid not null, id uuid not null, kind text not null, amount_vnd numeric(24,0) not null default 0, primary key (tenant_id, id))');
      await client.query('alter table machvon.rehearsal_ledger enable row level security');
      await client.query('alter table machvon.rehearsal_ledger force row level security');
      await client.query("create policy tenant_boundary on machvon.rehearsal_ledger using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)");
      await client.query('grant select, insert, update, delete on machvon.rehearsal_ledger to machvon_app');
      for (const [tenant, id, kind, amount] of rows) await client.query('insert into machvon.rehearsal_ledger (tenant_id, id, kind, amount_vnd) values ($1, $2, $3, $4)', [tenant, id, kind, amount]);
    });
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/u1/' }]);
  }, 180_000);

  afterAll(async () => {
    for (const path of scratch) rmSync(path, { recursive: true, force: true });
    await harness.stop();
  }, 60_000);

  const measure = (role: 'source' | 'restored', dir: string, database: string, files: string[]): Promise<number> => {
    const list = join(dir, `${role}-files.txt`);
    writeFileSync(list, `${files.join('\n')}\n`);
    return main(['measure', '--role', role, '--out', join(dir, `${role}.json`), '--tenants', `${TENANT_A},${TENANT_B}`, '--files-list', list], envOn(database), io);
  };
  const compare = (dir: string, started: Date, recoveryPoint: Date, restoredTo: Date, verifiedAt: Date): Promise<number> =>
    main(
      ['compare', '--source', join(dir, 'source.json'), '--restored', join(dir, 'restored.json'), '--recovery-point', recoveryPoint.toISOString(), '--restored-to', restoredTo.toISOString(), '--started-at', started.toISOString(), '--verified-at', verifiedAt.toISOString(), '--out', join(dir, 'report.json')],
      {},
      io,
    );

  it('restores a copy, measures both clusters, compares them and finds them the same, within the targets of RPO and RTO', async () => {
    const dir = folder();
    const recoveryPoint = new Date();
    expect(await measure('source', dir, sourceName(), FILES)).toBe(0);
    const started = new Date();
    await restoreInto('machvon_rehearsal_ok');
    const restoredTo = recoveryPoint;
    expect(await measure('restored', dir, 'machvon_rehearsal_ok', FILES)).toBe(0);
    const verifiedAt = new Date();
    lines.length = 0;
    expect(await compare(dir, started, recoveryPoint, restoredTo, verifiedAt)).toBe(0);
    expect(lines).toContain('VERDICT: matches and meets the targets');
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as DrillReport;
    expect(report.matched).toBe(true);
    expect(report.within_targets).toBe(true);
    expect(report.tenants.map((entry) => entry.tenant_id)).toEqual([TENANT_A, TENANT_B].sort());
    expect(report.tenants.find((entry) => entry.tenant_id === TENANT_A)?.money_expected_vnd).toBe('3500');
    expect(report.rpo_seconds).toBe(0);
    expect(report.files).toEqual({ expected: expect.objectContaining({ references: 3 }), restored: expect.objectContaining({ references: 3 }), match: true });
    const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as DrillManifest;
    expect(source.tenants[TENANT_A]?.tables.rehearsal_ledger).toMatchObject({ rows: 2, money: { amount_vnd: '3500' } });
    // What a rehearsal leaves behind says that it is one, so nobody files it as the evidence of a drill.
    writeFileSync(join(dir, 'rehearsal-summary.json'), `${JSON.stringify({ mode: 'LOCAL_REHEARSAL', ledgerEligible: false, restore: 'CREATE DATABASE TEMPLATE', verdict: 'matches', rtoSeconds: report.rto_seconds, rpoSeconds: report.rpo_seconds }, null, 2)}\n`);
  }, 180_000);

  it('can fail: a restored copy that lost a row or changed an amount, or whose files are missing, is not a match and is told by exit code 1', async () => {
    const dir = folder();
    const point = new Date();
    expect(await measure('source', dir, sourceName(), FILES)).toBe(0);
    const started = new Date();
    await restoreInto('machvon_rehearsal_bad');
    await withClient(urlOn(harness.database.adminUrl, 'machvon_rehearsal_bad'), async (client) => {
      await client.query('delete from machvon.rehearsal_ledger where id = $1', [rows[0][1]]);
      await client.query('update machvon.rehearsal_ledger set amount_vnd = 98 where id = $1', [rows[2][1]]);
    });
    expect(await measure('restored', dir, 'machvon_rehearsal_bad', FILES.slice(0, 2))).toBe(0);
    lines.length = 0;
    expect(await compare(dir, started, point, point, new Date())).toBe(1);
    expect(lines).toEqual(expect.arrayContaining([`MISMATCH ${TENANT_A}:rows:rehearsal_ledger`, `MISMATCH ${TENANT_B}:money:rehearsal_ledger.amount_vnd`, 'MISMATCH file_references', 'VERDICT: the restore does NOT match the source']));
  }, 180_000);

  it('a restore that is whole but took longer than the RTO is told apart from a bad one: exit code 3', async () => {
    const dir = folder();
    const point = new Date();
    expect(await measure('source', dir, sourceName(), FILES)).toBe(0);
    await restoreInto('machvon_rehearsal_slow');
    expect(await measure('restored', dir, 'machvon_rehearsal_slow', FILES)).toBe(0);
    lines.length = 0;
    expect(await compare(dir, new Date(point.getTime() - 5 * 3_600_000), point, point, new Date())).toBe(3);
    expect(lines).toContain('VERDICT: matches, but misses the RPO or RTO target');
  }, 180_000);
});
