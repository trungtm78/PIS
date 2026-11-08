import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { ControlDatabase } from './control-database.ts';
import { registeredTenantIds } from './jobs.ts';
import { DRILL_SCHEMA_VERSION, compareDrill, drillReportReference, fileReferenceSummary, measureTenants } from './restore-drill.ts';
import type { DrillManifest } from './restore-drill.ts';
import { TenantDatabase } from './tenant-database.ts';

export interface Io {
  log: (line: string) => void;
}

const USAGE = [
  'Usage:',
  '  restore-drill-cli.ts measure --role source|restored --out <manifest.json> [--files-list <object keys, one per line>] [--tenants <id,id,...>]',
  '  restore-drill-cli.ts compare --source <manifest.json> --restored <manifest.json> --recovery-point <UTC> --restored-to <UTC> --started-at <UTC> --verified-at <UTC> --out <report.json>',
  'measure reads DATABASE_URL_APP (role machvon_app) and DATABASE_URL_CONTROL (role machvon_control) of the cluster it is pointed at: run it once against the source and once against the restored cluster.',
  'Exit codes of compare: 0 the restore matches and meets the RPO and RTO targets; 1 it does not match; 3 it matches but misses a target; 2 usage or configuration error.',
].join('\n');

const stdoutIo: Io = { log: (line) => process.stdout.write(`${line}\n`) };
const sha256OfFile = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function write(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function readManifest(path: string): DrillManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(path), 'utf8')) as DrillManifest;
    return manifest.schemaVersion === DRILL_SCHEMA_VERSION && typeof manifest.tenants === 'object' && manifest.tenants !== null ? manifest : undefined;
  } catch {
    return undefined;
  }
}

const instant = (value: string | undefined): Date | undefined => {
  const date = value === undefined ? undefined : new Date(value);
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
};

async function measure(values: Record<string, string | boolean | undefined>, env: Record<string, string | undefined>, io: Io): Promise<number> {
  const role = values.role;
  const out = values.out;
  const appUrl = env.DATABASE_URL_APP;
  const controlUrl = env.DATABASE_URL_CONTROL;
  if ((role !== 'source' && role !== 'restored') || typeof out !== 'string' || !appUrl || !controlUrl) {
    io.log(USAGE);
    return 2;
  }
  const appPool = new Pool({ connectionString: appUrl, max: 2 });
  const controlPool = new Pool({ connectionString: controlUrl, max: 1 });
  try {
    const tenantIds = typeof values.tenants === 'string' && values.tenants !== '' ? values.tenants.split(',') : await registeredTenantIds(new ControlDatabase(controlPool));
    const files = typeof values['files-list'] === 'string' ? fileReferenceSummary(readFileSync(resolve(values['files-list']), 'utf8').split(/\r?\n/)) : undefined;
    const manifest = await measureTenants(new TenantDatabase(appPool), tenantIds, role, { files });
    write(out, manifest);
    io.log(`manifest ${role}: ${Object.keys(manifest.tenants).length} tenants, written to ${out}`);
    io.log(`sha256 ${sha256OfFile(out)}  ${out}`);
    return 0;
  } finally {
    await Promise.all([appPool.end(), controlPool.end()]);
  }
}

function compare(values: Record<string, string | boolean | undefined>, io: Io): number {
  const source = typeof values.source === 'string' ? readManifest(values.source) : undefined;
  const restored = typeof values.restored === 'string' ? readManifest(values.restored) : undefined;
  const [recoveryPoint, restoredTo, startedAt, verifiedAt] = ['recovery-point', 'restored-to', 'started-at', 'verified-at'].map((name) => instant(values[name] as string | undefined));
  if (source === undefined || restored === undefined || recoveryPoint === undefined || restoredTo === undefined || startedAt === undefined || verifiedAt === undefined || typeof values.out !== 'string') {
    io.log(USAGE);
    return 2;
  }
  const report = compareDrill(source, restored, { recoveryPoint, restoredTo, startedAt, verifiedAt });
  write(values.out, report);
  io.log(`drill report ${drillReportReference(report)}`);
  io.log(`sha256 ${sha256OfFile(values.out)}  ${values.out}`);
  io.log(`sha256 ${sha256OfFile(values.source as string)}  ${values.source as string}`);
  io.log(`sha256 ${sha256OfFile(values.restored as string)}  ${values.restored as string}`);
  io.log(`tenants ${report.tenants.length} compared, ${report.missing_tenants.length} missing, ${report.unexpected_tenants.length} unexpected; files ${report.files.match ? 'match' : 'DIFFER'}`);
  io.log(`rpo ${report.rpo_seconds} s (target ${report.rpo_target_seconds}), rto ${report.rto_seconds} s (target ${report.rto_target_seconds})`);
  for (const mismatch of report.mismatches) io.log(`MISMATCH ${mismatch}`);
  if (!report.matched) {
    io.log('VERDICT: the restore does NOT match the source');
    return 1;
  }
  io.log(report.within_targets ? 'VERDICT: matches and meets the targets' : 'VERDICT: matches, but misses the RPO or RTO target');
  return report.within_targets ? 0 : 3;
}

/** The restore drill of the whole cluster (docs/runbooks/infra/restore-drill.md): the manifests it compares are made with the measure that verifies a tenant restore, and the comparison is `verifyRestore`. */
export async function main(argv: string[], env: Record<string, string | undefined> = process.env, io: Io = stdoutIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        role: { type: 'string' },
        out: { type: 'string' },
        'files-list': { type: 'string' },
        tenants: { type: 'string' },
        source: { type: 'string' },
        restored: { type: 'string' },
        'recovery-point': { type: 'string' },
        'restored-to': { type: 'string' },
        'started-at': { type: 'string' },
        'verified-at': { type: 'string' },
      },
    });
  } catch {
    io.log(USAGE);
    return 2;
  }
  const [command] = parsed.positionals;
  if (command === 'measure') return measure(parsed.values, env, io);
  if (command === 'compare') return compare(parsed.values, io);
  io.log(USAGE);
  return 2;
}
