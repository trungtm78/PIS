import { createHash, randomUUID } from 'node:crypto';
import type { AuthzHarness } from './authz-fixtures';
import { memberId, unitId } from './authz-fixtures';

/** What a line of a fixture snapshot looks like; every field has a default that passes the usual rules. */
export interface LineSpec {
  /** A project that exists in the tenant, or a reference to none (an orphan, or a project of another tenant). */
  project?: 'real' | 'dangling';
  ctmtqg?: string;
  planTotal?: string;
  bucket?: string;
  rateTotal?: string | null;
}

export interface SnapshotSeed {
  lines?: LineSpec[];
  status?: string;
  asOfAt?: string;
  rowCountDelta?: number;
}

export interface SeededSnapshot {
  id: string;
  sha256: string;
  projectIds: string[];
}

/**
 * The fixtures write snapshots and projects directly. The foreign keys of these tables are dropped, so that an orphan reference (the defect an
 * integrity rule exists to find) can be written, and so that a project needs no master data behind it. Call once, after the database started.
 */
export async function dropSnapshotFixtureKeys(harness: AuthzHarness, tenantId: string): Promise<void> {
  const keys = await harness.owner<{ table: string; name: string }>(tenantId, [
    [
      `select conrelid::regclass::text as "table", conname as name from pg_constraint
        where contype = 'f' and conrelid in ('machvon.period_snapshot'::regclass, 'machvon.period_snapshot_line'::regclass, 'machvon.project'::regclass)`,
    ],
  ]);
  for (const key of keys) await harness.owner(tenantId, [[`alter table ${key.table} drop constraint ${key.name}`]]);
}

/** A period snapshot with the given lines, in the state the seed says (FROZEN by default, with the digest and the row count a frozen snapshot has). */
export async function seedSnapshot(harness: AuthzHarness, tenantId: string, actor: number, seed: SnapshotSeed = {}): Promise<SeededSnapshot> {
  const lines = seed.lines ?? [{}, {}, {}, {}];
  const snapshotId = randomUUID();
  const sha256 = createHash('sha256').update(snapshotId).digest('hex');
  const status = seed.status ?? 'FROZEN';
  const final = status === 'FROZEN' || status === 'SUPERSEDED';
  await harness.owner(tenantId, [
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count,
          payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', coalesce($4::timestamptz, now()), current_date, current_date, $5, 'v1', 'PROPOSED_PENDING_SIGNOFF', $6, $7, $8, $9, $8, $8)`,
      [tenantId, snapshotId, randomUUID(), seed.asOfAt ?? null, status, lines.length + (seed.rowCountDelta ?? 0), final ? sha256 : null, memberId(actor), final ? new Date().toISOString() : null],
    ],
  ]);
  const projectIds: string[] = [];
  for (const line of lines) {
    const projectId = randomUUID();
    projectIds.push(projectId);
    if ((line.project ?? 'real') === 'real') {
      await harness.owner(tenantId, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
           values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'CONCEPT', 1, $6, $6)`,
          [tenantId, projectId, `PRJ-${randomUUID().slice(0, 8)}`, unitId(1), randomUUID(), memberId(actor)],
        ],
      ]);
    }
    const planTotal = line.planTotal ?? '1000';
    await harness.owner(tenantId, [
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd,
            ctmtqg_subset_vnd, rate_total_pct, rate_null_reason, treasury_coverage)
         values ($1, $2, $3, $4, $5, $6, 'CENTRAL', $7, 0, $7, $8, $9, $10, 'COMPLETE')`,
        [tenantId, randomUUID(), snapshotId, projectId, unitId(1), line.bucket ?? 'CURRENT_YEAR', planTotal, line.ctmtqg ?? '500', line.rateTotal === undefined ? '50' : line.rateTotal, line.rateTotal === null ? 'NO_DATA' : null],
      ],
    ]);
  }
  return { id: snapshotId, sha256, projectIds };
}

/** A working contract bound to a dataset (what rules and runs are written against). */
export async function seedWorkingContract(harness: AuthzHarness, tenantId: string, datasetId: string, datasetCode: string, ownerMember: number, revision = 1): Promise<string> {
  const contractId = randomUUID();
  await harness.owner(tenantId, [
    [
      `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
       values ($1, $2, $3, $6, $4, '{}'::jsonb, '{}'::jsonb, 86400, 'INTERNAL', 'DRAFT', $5)`,
      [tenantId, contractId, datasetCode, memberId(ownerMember), datasetId, revision],
    ],
  ]);
  return contractId;
}

/** A finished run of a dataset, `ageHours` old, with the verdict and the score given (as a measured run would leave them). */
export async function seedFinishedRun(
  harness: AuthzHarness,
  tenantId: string,
  run: { datasetId: string; contractId: string; ageHours: number; overall: 'PASSED' | 'WARNING' | 'FAILED'; score: string; hardFail?: boolean },
): Promise<string> {
  const id = randomUUID();
  const hardFail = run.hardFail ?? false;
  await harness.owner(tenantId, [
    [
      `insert into machvon.quality_run (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, started_at, finished_at, dataset_id, trigger, status, overall_result, score, hard_fail, certified_blocked)
       values ($1, $2, $3, $4, jsonb_build_array(($2::uuid)::text), 1, 0, 0, now() - $5::numeric * interval '1 hour', now() - $5::numeric * interval '1 hour', $6, 'MANUAL', 'COMPLETED', $7, $8::numeric, $9, $9)`,
      [tenantId, id, run.contractId, randomUUID(), run.ageHours, run.datasetId, run.overall, run.score, hardFail],
    ],
  ]);
  return id;
}
