import { NOOP_ALERTS, NOOP_METRICS, auditLeafHash, canonicalJson, merkleRoot, sealHashOf } from '@machvon/kernel';
import type { AlertSink, MetricsSink, TenantContext } from '@machvon/kernel';
import { AUDIT_LOCK_KEY_SQL } from './audit-writer.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

export interface SealOutcome {
  sealed: number;
  seals: number;
}

export type BrokenReason = 'ROOT_MISMATCH' | 'SEAL_HASH_MISMATCH' | 'CHAIN_LINK_MISMATCH' | 'UNSEALED_ROW_IN_GAP';

export type VerifyOutcome =
  | { ok: true; seals: number }
  | { ok: false; seals: number; brokenAt: { sealId: string; fromSeq: number; toSeq: number; reason: BrokenReason } };

export interface AuditSealJobOptions {
  windowRows?: number;
  metrics?: MetricsSink;
  alerts?: AlertSink;
}

interface PreviousSeal {
  sealHash: string;
  toSeq: number;
}

const DEFAULT_WINDOW_ROWS = 1000;
const SEAL_PAGE_SIZE = 100;

// occurred_at keeps microseconds only as text; the same expression is used when sealing and verifying.
export const AUDIT_ROW_COLUMNS = `id, seq, actor_id, action, resource_type, resource_id, safe_diff, reason, correlation_id, request_id,
  outcome, classification, impersonator_id, on_behalf_of_id, ip_hash, schema_version,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at`;

/** One audit row as the sealer reads it: the columns of AUDIT_ROW_COLUMNS, whose canonical JSON is the Merkle leaf. */
export interface AuditRow {
  id: string;
  seq: string;
  [column: string]: unknown;
}

interface SealRow {
  id: string;
  from_seq: string;
  to_seq: string;
  merkle_root: string;
  prev_seal_hash: string | null;
  seal_hash: string;
}

export const leafOf = (row: AuditRow): string => auditLeafHash(canonicalJson({ ...row, seq: Number(row.seq) }));
const rootOf = (rows: readonly AuditRow[]): string => merkleRoot(rows.map(leafOf));

/** Seals the audit rows of one tenant into chained Merkle windows and verifies the chain. */
export class AuditSealJob {
  private readonly database: TenantDatabase;
  private readonly windowRows: number;
  private readonly metrics: MetricsSink;
  private readonly alerts: AlertSink;

  constructor(database: TenantDatabase, options: AuditSealJobOptions = {}) {
    const windowRows = options.windowRows ?? DEFAULT_WINDOW_ROWS;
    if (!Number.isSafeInteger(windowRows) || windowRows < 1) throw new RangeError('windowRows must be a positive integer');
    this.database = database;
    this.windowRows = windowRows;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.alerts = options.alerts ?? NOOP_ALERTS;
  }

  /** Seals every row after the last seal, in chunks of `windowRows`, under the exclusive audit lock. */
  seal(ctx: TenantContext): Promise<SealOutcome> {
    return this.database.withTenant(ctx, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY_SQL})`);
      const [last] = await tx.query<SealRow>('select to_seq, seal_hash from machvon.audit_seal order by to_seq desc limit 1');
      let prevHash = last?.seal_hash ?? null;
      let afterSeq = last === undefined ? 0 : Number(last.to_seq);
      const outcome: SealOutcome = { sealed: 0, seals: 0 };
      for (;;) {
        const rows = await tx.query<AuditRow>(
          `select ${AUDIT_ROW_COLUMNS} from machvon.audit_event where seq > $1 order by seq limit $2`,
          [afterSeq, this.windowRows],
        );
        const first = rows[0];
        const lastRow = rows[rows.length - 1];
        if (first === undefined || lastRow === undefined) return outcome;
        const root = rootOf(rows);
        const toSeq = Number(lastRow.seq);
        const sealHash = sealHashOf(prevHash, root, toSeq);
        await tx.query(
          `insert into machvon.audit_seal (tenant_id, id, from_seq, to_seq, merkle_root, prev_seal_hash, seal_hash)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [Number(first.seq), toSeq, root, prevHash, sealHash],
        );
        outcome.sealed += rows.length;
        outcome.seals += 1;
        prevHash = sealHash;
        afterSeq = toSeq;
      }
    });
  }

  /**
   * Walks the seals in order and reports the first window that fails; a failure raises AUDIT_CHAIN_BROKEN. The verdict is
   * then kept (audit_seal_check) for the audit viewer, after the alert: a failure to keep it can never hide the failure.
   */
  async verify(ctx: TenantContext): Promise<VerifyOutcome> {
    const outcome = await this.database.withTenant(ctx, (tx) => this.walk(tx));
    if (!outcome.ok) {
      this.metrics.increment('audit_seal_failures_total', { tenant_id: ctx.tenantId });
      this.alerts.raise('AUDIT_CHAIN_BROKEN', { tenantId: ctx.tenantId, ...outcome.brokenAt });
    }
    await this.database.withTenant(ctx, (tx) => recordVerdict(tx, outcome));
    return outcome;
  }

  private async walk(tx: TenantTx): Promise<VerifyOutcome> {
    let prev: PreviousSeal | null = null;
    let seals = 0;
    for (;;) {
      const page: SealRow[] = await tx.query<SealRow>(
        'select id, from_seq, to_seq, merkle_root, prev_seal_hash, seal_hash from machvon.audit_seal where to_seq > $1 order by to_seq limit $2',
        [prev?.toSeq ?? 0, SEAL_PAGE_SIZE],
      );
      if (page.length === 0) return { ok: true, seals };
      for (const seal of page) {
        const reason = await this.check(tx, seal, prev);
        seals += 1;
        if (reason !== undefined) {
          return { ok: false, seals, brokenAt: { sealId: seal.id, fromSeq: Number(seal.from_seq), toSeq: Number(seal.to_seq), reason } };
        }
        prev = { sealHash: seal.seal_hash, toSeq: Number(seal.to_seq) };
      }
    }
  }

  private async check(tx: TenantTx, seal: SealRow, prev: PreviousSeal | null): Promise<BrokenReason | undefined> {
    if ((seal.prev_seal_hash ?? null) !== (prev?.sealHash ?? null)) return 'CHAIN_LINK_MISMATCH';
    const gap = await tx.query<{ n: string }>('select count(*) as n from machvon.audit_event where seq > $1 and seq < $2', [
      prev?.toSeq ?? 0,
      Number(seal.from_seq),
    ]);
    if (Number(gap[0]?.n) > 0) return 'UNSEALED_ROW_IN_GAP';
    const rows = await tx.query<AuditRow>(`select ${AUDIT_ROW_COLUMNS} from machvon.audit_event where seq between $1 and $2 order by seq`, [
      Number(seal.from_seq),
      Number(seal.to_seq),
    ]);
    if (rows.length === 0 || rootOf(rows) !== seal.merkle_root) return 'ROOT_MISMATCH';
    if (sealHashOf(seal.prev_seal_hash, seal.merkle_root, Number(seal.to_seq)) !== seal.seal_hash) return 'SEAL_HASH_MISMATCH';
    return undefined;
  }
}

/** Replaces the kept verdict of the tenant of the transaction with this run's. */
async function recordVerdict(tx: TenantTx, outcome: VerifyOutcome): Promise<void> {
  const broken = outcome.ok ? undefined : outcome.brokenAt;
  await tx.query(
    `insert into machvon.audit_seal_check (tenant_id, checked_at, ok, seals, broken_seal, broken_from_seq, broken_to_seq, broken_reason)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, now(), $1, $2, $3, $4, $5, $6)
     on conflict (tenant_id) do update
       set checked_at = excluded.checked_at, ok = excluded.ok, seals = excluded.seals, broken_seal = excluded.broken_seal,
           broken_from_seq = excluded.broken_from_seq, broken_to_seq = excluded.broken_to_seq, broken_reason = excluded.broken_reason`,
    [outcome.ok, outcome.seals, broken?.sealId ?? null, broken?.fromSeq ?? null, broken?.toSeq ?? null, broken?.reason ?? null],
  );
}

/** The verdict of the last run of the seal verification of a tenant (ST-ADM-016). */
export interface SealCheck {
  /** `UNKNOWN`: never verified; `STALE`: the last run is older than three runs of the hourly job; otherwise the verdict of that run. */
  status: 'OK' | 'BROKEN' | 'STALE' | 'UNKNOWN';
  checkedAt: string | null;
  seals: number | null;
  broken: { sealId: string; fromSeq: number; toSeq: number; reason: BrokenReason } | null;
}

/** The verifier runs hourly (JOB_INTERVAL_SECONDS 'audit-verify'); a verdict older than this has missed three runs. */
export const SEAL_CHECK_STALE_SECONDS = 3 * 3600;

interface CheckRow {
  checked_at: string;
  ok: boolean;
  seals: number;
  broken_seal: string | null;
  broken_from_seq: string | null;
  broken_to_seq: string | null;
  broken_reason: BrokenReason | null;
  age_seconds: number;
}

/** Reads the kept verdict of the tenant of the transaction. A broken chain is reported even when the verdict is old. */
export async function readSealCheck(tx: TenantTx): Promise<SealCheck> {
  const rows = await tx.query<CheckRow>(
    `select to_char(checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as checked_at, ok, seals, broken_seal,
            broken_from_seq::text as broken_from_seq, broken_to_seq::text as broken_to_seq, broken_reason,
            extract(epoch from (now() - checked_at))::float8 as age_seconds
       from machvon.audit_seal_check`,
  );
  const row = rows[0];
  if (row === undefined) return { status: 'UNKNOWN', checkedAt: null, seals: null, broken: null };
  const broken =
    row.ok || row.broken_seal === null || row.broken_from_seq === null || row.broken_to_seq === null || row.broken_reason === null
      ? null
      : { sealId: row.broken_seal, fromSeq: Number(row.broken_from_seq), toSeq: Number(row.broken_to_seq), reason: row.broken_reason };
  const status = !row.ok ? 'BROKEN' : row.age_seconds > SEAL_CHECK_STALE_SECONDS ? 'STALE' : 'OK';
  return { status, checkedAt: row.checked_at, seals: row.seals, broken };
}
